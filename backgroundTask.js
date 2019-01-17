/** Copyright 2018 Cisco and/or its affiliates

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

 http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */
/**
 * Created by tmaoz on 23/08/2017.
 */
const Agenda  = require('agenda');
const os      = require('os');
const process = require('process');
const log4js  = require('log4js');
const logger  = require('./logger.js');

var MONGODB_HOST = 'localhost';
var MONGODB_PORT = 27017;

var BackgroundTask = function () {
    this.agenda = undefined;
    this.interval = '1 second';
    this.jobTypes = {};

    log4js.configure(logger.config);
    this.log = log4js.getLogger('agenda');
};

BackgroundTask.prototype.defineJob = function(name, jobType) {
    this.agenda.define(name, (job, done) => {
        this.log.debug(logger.formatLogMsg("Executing job '" + name + "'"));
        this.jobTypes[jobType](job.attrs.data).then(() => {
            job.save()
            done();
        }).catch((err) => {
            this.log.error(logger.formatLogMsg("Error defining Agenda job: " + err));
        });
    });
};

BackgroundTask.prototype.init = function (mongoDbHost, interval, jobs, success, error) {
    this.jobTypes = jobs;
    this.interval = interval;

    var host = MONGODB_HOST;
    var port = MONGODB_PORT;

    if (mongoDbHost) {
        var parts = mongoDbHost.split(":");
        host = parts[0];
        if (parts[1]) {
            port = parts[1];
        }
    }

    var mongoConnectionString = 'mongodb://' + host + ':' + port + "/agenda";
    this.agenda = new Agenda(
        {
            db: {
                address: mongoConnectionString,
                collection: 'bandwidth-orchestration'
            },
            name: 'bandwidth-orchestration'
        });

    this.agenda.on('ready', () => {
        this.log.info(logger.formatLogMsg("Agenda connected to MongoDB at " + host + ":" + port));

        // re register jobs from the DB
        this.agenda.jobs({}, (err, jobs) => {
            if (err) {
                this.log.error(logger.formatLogMsg("Error fetching exiting Agenda jobs from DB: " + err));
            } else {
                jobs.forEach(job => {
                    if (this.jobTypes[job.attrs.data.jobType]) {
                        this.log.info(logger.formatLogMsg("Registering job '" + job.attrs.name + "'"));
                        this.defineJob(job.attrs.name,job.attrs.data.jobType);
                    }
                });
            }
        });

        this.agenda
            .processEvery('1 second')
            .maxConcurrency(5)
            .start();

        success();
    });

    this.agenda.on('error', (err) => {
        this.log.error(logger.formatLogMsg("Error connecting to MongoDB: " + err));
        error(err);
    });
};

BackgroundTask.prototype.health = function () {
    return this.agenda._mdb.serverConfig.isConnected();
};

BackgroundTask.prototype.launch = function (name, jobType, data, options) {

    this.defineJob(name, jobType);

    return new Promise((resolve, reject) => {
        this.agenda
            .every(this.interval, name, {data: data, options: options, jobType: jobType}, {}, () => {
                resolve();
            });
    });
};

BackgroundTask.prototype.cancel = function (name, success, error) {
    this.agenda.cancel({name: name}, (err, numRemoved) => {
        if (err) {
            this.log.error(logger.formatLogMsg("Error removing Agenda job '" + name + "': " + err));
            error();
        } else {
            this.log.info(logger.formatLogMsg("Removed " + numRemoved + " Agenda jobs named '" + name + "'"));
            success();
        }
    });
};

BackgroundTask.prototype.list = function(cb) {

    return new Promise((resolve, reject) => {
        var res = [];

        this.agenda.jobs({}, (err, jobs) => {
            if (err) {
                this.log.error(logger.formatLogMsg("Error fetching exiting Agenda jobs from DB: " + err));
                reject();
            } else {
                for (item in jobs) {
                    job = jobs[item];
                    res.push(cb(job.attrs.name, job.attrs.data.jobType, job.attrs.data.data, job.attrs.data.options));
                }
                resolve(res);
            }
        });
    });
};

BackgroundTask.prototype.purge = function() {
    return new Promise((resolve,reject) => {
        bla = new Promise((resolve1, reject1) => {
            this.agenda.purge((err, numRemoved) => { resolve1(); });
        });
        bla.then(() => {
            this.agenda.cancel({}, (err, numRemoved) => {
                if (err) {
                    this.log.error(logger.formatLogMsg("Error fetching exiting Agenda jobs from DB: " + err));
                    reject();
                } else {
                    resolve(numRemoved);
                }
            });
        });
    });
};

module.exports = new BackgroundTask();