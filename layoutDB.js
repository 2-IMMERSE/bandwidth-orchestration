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
 * Created by tmaoz on 11/09/2017.
 */
var mongodb = require('mongodb');
const log4js = require('log4js');
const logger = require('./logger.js');

var MONGODB_HOST = 'localhost';
var MONGODB_PORT = 8086;
var MONGODB_DATABASE = 'layout_service';

// A client to talk to the LayoutService's database
var LayoutDB = function() {
    this.client = undefined;
    this.collection = undefined;

    log4js.configure(logger.config);
    this.log = log4js.getLogger('mongodb');
};

LayoutDB.prototype.init = function(host) {

    if (host) {
        var parts = host.split(":");
        MONGODB_HOST = parts[0];
        if (parts[1]) {
            MONGODB_PORT = parts[1];
        }
    }

    /* Initialize MongoDB connection */
    this.log.info(logger.formatLogMsg(`Connecting to MongoDB at ${MONGODB_HOST}:${MONGODB_PORT}`));
    return new Promise((resolve, reject) => {
        mongodb.MongoClient.connect(`mongodb://${MONGODB_HOST}:${MONGODB_PORT}/${MONGODB_DATABASE}`)
            .then(db => {
                this.client = db;
                this.collection = this.client.collection('layouts');
                this.log.info(logger.formatLogMsg("MongoDB connection established!"));
                resolve(this.client);
            }).catch(err => {
                this.log.error(logger.formatLogMsg("Error connecting to MongoDB: " + err));
                reject();
            });
        })
};

// Get the list of components in the given DMApp and context
LayoutDB.prototype.getComponents = function(contextId, DMAppId) {
    return new Promise((resolve, reject) => {
        this.log.debug(logger.formatLogMsg("Getting data for [" + contextId + " / " + DMAppId + "]"));
        this.collection.findOne({'_id': new mongodb.ObjectID(contextId)})
            .then(doc => {
                this.log.debug(logger.formatLogMsg("Got some data for [" + contextId + " / " + DMAppId + "] = " + Object.keys(doc).length));
                if (doc) {
                    resolve(extractComponents(doc, DMAppId));
                    return;
                }
                reject(`No such context '${contextId}!`);
            }).catch(err => {
                this.log.error(logger.formatLogMsg("Error getting docs: " + err));
                reject();
            });
    });
};

// Is the MongoDB client healthy?
LayoutDB.prototype.health = function() {
    return this.client.serverConfig.isConnected();
}

// Close the MondoDB client connection
LayoutDB.prototype.close = function() {
    this.collection = undefined;
    this.db.close();
    this.db = undefined;
}

// Get the info about active components in the given layout
function extractComponents(layout, DMAppId) {
    var components = {};
    for (var deviceId in layout.devices) {
        var device = layout.devices[deviceId];
        for (var compId in device.components) {
            var component = device.components[compId];
            if (component.DMAppId == DMAppId) {
                components[component.layout.instanceId] = {
                    'priority': component.layout.priority
                };
            }
        }
    }

    return components;
}

module.exports = new LayoutDB();
