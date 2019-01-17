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
 * Created by tmaoz on 24/08/2017.
 */
const Influx = require('influx');
const log4js = require('log4js');
const logger = require('./logger.js');

var INFLUX_HOST = 'localhost';
var INFLUX_PORT = 8086;

// An InfluxDB client with our required functions
var TimeSeries = function() {
    this.influx = undefined;

    log4js.configure(logger.config);
    this.log = log4js.getLogger('influxdb');

};

// Initialize the InfluxDB connection
TimeSeries.prototype.init = function(host) {

    if (host) {
        var parts = host.split(":");
        INFLUX_HOST = parts[0];
        if (parts[1]) {
            INFLUX_PORT = parts[1];
        }
    }

    /* Initialize InfluxDB connection */
    this.log.info(logger.formatLogMsg(`Connecting to InfluxDB at ${INFLUX_HOST}:${INFLUX_PORT}`));
    this.influx = new Influx.InfluxDB({
        host: INFLUX_HOST,
        port: INFLUX_PORT
    });

    return this.health(true);
};

// Check if the connection to InfluxDB is healthy via a Ping call
TimeSeries.prototype.health = function(verbose) {
    return new Promise((resolve, reject) => {
        
        // verify influx connection
        this.influx.ping(5000).then(hosts => {
            if (hosts) {
                var online = 0;
                hosts.forEach(host => {
                    if (host.online) {
                        if (verbose) {
                            this.log.info(logger.formatLogMsg("InfluxDB host online: " + host.url.host));
                        }
                        online++;
                    }
                });
                if (online > 0) {
                    if (verbose) {
                        this.log.info(logger.formatLogMsg("Seems like InfluxDB connection is good"));
                    }
                    resolve("Seems like InfluxDB connection is good");
                } else {
                    if (verbose) {
                        this.log.error(logger.formatLogMsg("No InfluxDB servers are online!"));
                    }
                    reject("Failed to establish InfluxDB connection!");
                }
            } else {
                if (verbose) {
                    this.log.error(logger.formatLogMsg("Error getting InfluxDB hosts list!"));
                }
                reject("Error getting InfluxDB hosts list!");
            }
        }).catch(err => {
            if (verbose) {
                this.log.error(logger.formatLogMsg("Error pinging InfluxDB servers!"));
            }
            reject("Error pinging InfluxDB servers...");
        });
    });
};

// Create a new time series table
TimeSeries.prototype.createNewSeries = function(name) {

    // create database
    return new Promise((resolve, reject) => {
        this.influx.getDatabaseNames()
            .then(names => {
                if (!names.includes(name)) {
                    return this.influx.createDatabase(name);
                }
            })
            .then(() => {
                this.log.info(logger.formatLogMsg("Created new database [" + name + "]"));

                // keep entries for an hour before deleting
                this.influx.createRetentionPolicy('1h',
                    {
                        database: name,
                        duration: '60m',
                        replication: 1,
                        isDefault: true
                    })
                    .then (() => {
                        this.log.debug(logger.formatLogMsg("Created retention policy '1h' for [" + name + "]"));
                        resolve();
                    })
                    .catch(err => {
                        this.log.error(logger.formatLogMsg("FAILED to create retention policy '1h' for [" + name + "]: " + err));
                        reject();
                    });
            })
            .catch(err => {
                this.log.error(logger.formatLogMsg("FAILED to create new database for [" + name + "]"));
                reject();
            });
    });
};

// Delete a time series table
TimeSeries.prototype.deleteSeries = function(name) {
    return new Promise((resolve, reject) => {
        this.influx.dropDatabase(name)
            .then(() => {
                this.log.info(logger.formatLogMsg("Dropped database [" + name + "]"));
                resolve();
            })
            .catch(() => {
                this.log.error(logger.formatLogMsg("Failed to drop database [" + name + "]"));
                reject();
            });
    });
};

// cleanup the entire database
TimeSeries.prototype.purge = function() {
    return new Promise((resolve, reject) => {

        this.influx.getDatabaseNames()
            .then(names => {
                if (names.length == 0) {
                    resolve();
                    return;
                }

                var promise =
                    this.influx.dropDatabase(names[0])
                var i=1;
                for (; i<names.length; i++) {
                    promise = promise.then(() => {
                        this.influx.dropDatabase(names[i]);
                    }).catch(err => {
                        this.log.error(logger.formatLogMsg("Error dropping database " + names[i-1]));
                        reject(err);
                    });
                }
                promise.then(() => {
                    resolve();
                }).catch(err => {
                    this.log.error(logger.formatLogMsg("Error dropping database " + names[i-1]));
                })
            }).catch(err => {
                this.log.error(logger.formatLogMsg("Error getting list of databases: " + err));
                reject();
            })
        });
};

// Push time series data into a table
TimeSeries.prototype.writePoints = function(name, time, data, tags) {
    return new Promise((resolve, reject) => {
        this.influx.writePoints([{
            measurement: 'sand_metrics',
            fields: data,
            timestamp: time * 1000000,
            tags: tags
        }], { database: name })
        .then(() => {
            resolve();
        }).catch(err => {
            this.log.error(logger.formatLogMsg("Error saving data to InfluxDB: " + err.stack));
            reject();
        });
    });
};

// Get all the data is a given table while doing some stats
TimeSeries.prototype.getMetrics = function(name) {
    return new Promise((resolve, reject) => {

        // InfluxDB query to get all the data for the past minute
         this.influx.query(`
            select * from sand_metrics
            where time > now()-60s
            group by instanceId
            order by time desc            
         `, {database: name})
             .then(result => {
                 var stats = {};

                 // don't have stats yet...
                 if (result.groups().length == 0) {
                     resolve({});
                 }

                 // go over the data groups (components) and collect relevant information
                 var groups = result.groups();
                 for (var i in groups) {
                     var group = groups[i].rows;
                     var component = group[0].instanceId;

                     // calculate average video bandwidth usage for this group
                     var videoBandwidth = group.reduce(
                         function (sum, value) {
                             return sum + value.videoBandwidth;
                         }, 0) / group.length;

                     // calculate average audio bandwidth usage for this group
                     var audioBandwidth = group.reduce(
                             function (sum, value) {
                                 return sum + value.audioBandwidth;
                             }, 0) / group.length;

                     // get available bitrates for this group
                     var bitrates = JSON.parse(group[0].bitrates);
                     this.log.trace(logger.formatLogMsg("[" + component + "]: " + videoBandwidth));

                     // create data struct for this group
                     stats[component] = {
                         videoBandwidth: videoBandwidth,
                         audioBandwidth: audioBandwidth,
                         bandwidth: videoBandwidth + audioBandwidth,
                         bitrates: bitrates,
                         playingVideoBitrate: group[0].playingVideoBitrate,
                         maxBitrate: bitrates.video.slice(-1)[0] + bitrates.audio.slice(-1)[0]
                     }
                 }

                 resolve(stats);
             }).catch(err => {
                this.log.error(logger.formatLogMsg("Error fetching data from InfluxDB: " + err));
                reject();
             });
    });
};

module.exports = new TimeSeries();
