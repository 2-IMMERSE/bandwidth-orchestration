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
//<editor-fold desc="Requires">
const express     = require('express');
const bodyParser  = require('body-parser');
const http        = require('http');
const commander   = require('commander');
const url         = require('url');
const log4js      = require('log4js');

const timeSeries     = require('./timeSeries.js');
const backgroundTask = require('./backgroundTask.js');
const layoutDB       = require('./layoutDB.js');
const websocket      = require('./websocket.js');

const logger         = require('./logger.js');
//</editor-fold>

//<editor-fold desc="Defaults & Consts">
// listen port
var PORT = 3000;

var CONSULE_SERVER = "https://consul.service.consul:8500";

// bandwidth calculation interval
var BACKGROUND_TASK_INTERVAL = '10 seconds';

// grace count before actually starting the bandwidth estimation so client can settle down
const BACKGROUND_TASK_GRACE_COUNT = 3;

// how much time to wait before deciding a client is dead
const DEAD_INACTIVITY_PERIOD = 1000 * 60 * 10; // 10 minutes

// how much time to wait with no data until deciding a client was never there
const NEVER_STARTED_PERIOD = 1000 * 60 * 60 * 24; // 24 hours

// default number of priority levels
const PRIORITY_LEVELS = 3;

//percent of given bandwidth measure to actually count
const BANDWIDTH_LIMIT_SAFETY = 0.95;

// maximum realistic bandwidth for a single player in B/s
var MAX_REALISTIC_BANDWIDTH = 20000000;
                                                        
const TURNEDOFF = -1;
const ACTIONS = {
    "DOWNGRADE": "downgrade",
    "UPGRADE": "upgrade",
    "PRESERVE": "preserve",
    "DISABLE": "disable"
};

// Consul service location
var consulService = undefined;
//</editor-fold>

//<editor-fold desc="Command-line Arguments">
// parse arguments
commander
    .option('-p, --port <port>', 'Set listener port', parseInt)
    .option('-i, --influx <host:port>', 'Set InfluxDB host (service name for Consul)')
    .option('-w, --websocket <url>', 'Set WebSocket server URL (service name for Consul)')
    .option('-m, --mongodb <host:port>', 'Set MongoDB host (service name for Consul)')
    .option('-c, --consul-host <host>', 'Consul host', CONSULE_SERVER)
    .option('-l, --local', 'Run standalone service with no Consul resolving')
    .option('-t, --interval', 'Background task interval in seconds', parseInt)
    .option('-b, --max-bandwidth', 'Maximum realistic bandwidth to filter browser caching', parseInt)
    .option('-q, --quiet', "Only INFO logging", false)
    .parse(process.argv);

if (commander.interval) {
    BACKGROUND_TASK_INTERVAL = commander.interval;
}
if (commander.maxBadwidth) {
    MAX_REALISTIC_BANDWIDTH = commander.maxBandwidth;
}

if (commander.consulHost != CONSULE_SERVER && commander.consulHost == "http") {
    CONSULE_SERVER = CONSULE_SERVER.replace("https://", "http://");
}

let logName = process.env.LOG_NAME || "BandwidthOrchestrationEdge";

if (commander.quiet) {
    logger.configure(logName, "INFO");
}
log4js.configure(logger.config);
var log = log4js.getLogger('index');
var apilog = log4js.getLogger('restapi');
var complog = log4js.getLogger('component');
var dmapplog = log4js.getLogger('dmapp');
//</editor-fold>

//<editor-fold desc="Web Service Init">
/** SERVICE **/
/* create server */
const app = express();

/* allow CORS */
app.use(function(req, res, next) {
    // basic request logging
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');

    // intercept OPTIONS method    
    if ('OPTIONS' == req.method) {
        res.sendStatus(200);
    } else {
        next();
    }
});

// parse JSON data
app.use(bodyParser.json());
//</editor-fold>

//<editor-fold desc="Rest API">
/** REST API **/
/* HealthCheck */
app.get('/healthcheck', function (req, res) {

    var allChecks = function(influx, consul) {

        // we are healthy if all the dependencies are healthy
        var healthStatus = {
            'consul': consul,
            'influxDB': influx,
            'websocket': websocket.health(),
            'layoutDB': layoutDB.health(),
            'agenda': backgroundTask.health()
        };

        for (var test in healthStatus) {
            if (!healthStatus[test]) {
                res.status(500).send(healthStatus);
                return;
            }
        }
        res.status(200).send(healthStatus);
    };

    timeSeries.health().then(() => {
        consulResolve("consul").then(() => {
            allChecks(true, true);
        }).catch(() => {
            allChecks(true, false);
        });
    }).catch(() => {
        consulResolve("consul").then(() => {
            allChecks(false, true);
        }).catch(() => {
            allChecks(false, false);
        });
    });
});

/* Initialize collection for a given DMApp */
app.post('/init', function (req, res) {
    initializeDMApp(req.body)
        .then (() => {
            res.sendStatus(200);
        })
        .catch (err => {
            res.sendStatus(500);
        })
});

/* stop tracking for a given DMApp, destroy all data! */
app.delete('/stop/:dmappid', function (req, res) {

    // get component id
    stopDMApp({DMAppId: req.params.dmappid})
        .then(() => {
            res.sendStatus(200);
        })
        .catch(() => {
            res.sendStatus(500);
        });
});

/* cleanup - stop ALL the DMApps and clean the DBs */
app.post('/clean/All/The/Stuff', function (req, res) {

    // cancel all background tasks
    backgroundTask.purge().then(numJobsRemoved => {

        // leave all rooms
        websocket.purge();

        // cleanup influx
        timeSeries.purge().then(() => {
            res.status(200).send(["removed " + numJobsRemoved + " job(s)"]);
        }).catch(err => {
            res.status(500).send(err);
        });
    }).catch(err => {
        res.status(500).send(err);
    });
});

/* status */
app.get('/status', function (req, res) {

    backgroundTask.list(function (name, type, data, options) {
       return {
           'name': name,
           'type': type,
           'contextId': data.contextId,
           'DMAppId': data.DMAppId,
           'grace': options.grace,
           'startedRunning': options.startedRunning,
           'lastActive': options.lastActive
       };
    }).then(jobs => {
        res.status(200).send(jobs);
    }).catch(() => {
        res.sendStatus(500);
    });
});

/* collect data for a given component in a given DMApp */
app.post('/collect', function (req, res) {

    var message = req.body;
    apilog.info(logger.formatLogMsg("Got message from [" + message.senderId + "]", {dmappID: message.dmappId, dmappcID: message.senderId}));

    // safety
    if (message.bandwidth.video.current > MAX_REALISTIC_BANDWIDTH) {
        complog.info(logger.formatLogMsg("Seems like component '" + message.senderId + "' for DMApp '" +
            message.dmappId + "' is playing cached data [" + message.bandwidth.video.current + "], skipping...", {dmappID: message.dmappId, dmappcID: message.senderId}));
        res.sendStatus(200);
        return;
    }

    if (!(message.senderId && message.dmappId)) {
        complog.info(logger.formatLogMsg("senderId and dmappId can't be empty!, skipping..."));
        res.status(400).send('{"error": "senderId and dmappId can NOT be empty!"}');
        return;
    }

    // put stats in DB
    timeSeries.writePoints(message.dmappId, message.generationTime, {
            instanceId: message.senderId,
            //avgVideoThroughput: message.averageThroughput.avgVideoThroughput,
            //avgAudioThroughput: message.averageThroughput.avgAudioThroughput,
            //avgThroughput: message.averageThroughput.avgThroughput,
            videoBandwidth: message.bandwidth.video.current * 8,
            audioBandwidth: message.bandwidth.audio.current * 8,
            playingVideoBitrate: message.bitrate.playing.video,
            playingAudioBitrate: message.bitrate.playing.audio,
            //queuedVideoBitrate: message.bitrate.queued.video,
            //queuedAudioBitrate: message.bitrate.queued.audio,
            bitrates: JSON.stringify(message.bitrates)
        }, {
            instanceId: message.senderId
        })
    .then(() => {
        res.sendStatus(200);
    }).catch(() => {
        res.sendStatus(500);
    });
});
//</editor-fold>

//<editor-fold desc="Modules Initialization">
/** Initialize **/
var server;
initConsul(CONSULE_SERVER, commander.local);

// Find InfluxDB
consulResolve(commander.influx).then(influxHost => {

    // Init InfluxDB client
    timeSeries.init(influxHost).then(msg => {

        // init layout database connection
        consulResolve(commander.mongodb).then(mongoHost => {
            layoutDB.init(mongoHost).then(db => {

                // init Background mechanism
                backgroundTask.init(mongoHost, BACKGROUND_TASK_INTERVAL,
                    {
                        evaluateDMApp: evaluateDMApp
                    },
                    () => {
                        consulResolve(commander.websocket).then(websocketHost => {
                            initWebSocket(websocketHost);
                            initServer(commander.port, app);
                        }).catch(err => {
                            throw(err);
                        });
                    },
                    (err) => {
                        log.error(logger.formatLogMsg("Failed to initialize Agenda: " + err));
                        throw(err);
                    });
            }).catch(err => {
                throw(err);
            });
        }).catch(err => {
            throw(err);
        });
    }).catch(err => {
        throw(err);
    });
}).catch (err => {
    throw(err);
});
//</editor-fold>

//<editor-fold desc="API Helpers">
/** API Helpers **/
/* initiate a DMApp tracker */
function initializeDMApp(data) {

    // get component id
    var DMAppId = data.DMAppId;

    return new Promise((resolve, reject) => {
        timeSeries.createNewSeries(DMAppId)
            // kick off the background task
            .then(() => {

                // define a job for this DMApp
                backgroundTask.launch(DMAppId, "evaluateDMApp", data, {
                    grace: BACKGROUND_TASK_GRACE_COUNT,
                    startedRunning: false,
                    lastActive: Date.now()
                }).then(() => {
                        websocket.joinRoom(DMAppId);
                        dmapplog.info(logger.formatLogMsg("Started a background task for DMApp [" + DMAppId + "]", {dmappID: DMAppId}));
                        resolve();
                    })
                    .catch((err) => {
                        dmapplog.error(logger.formatLogMsg("Failed to properly launch a background task for DMApp [" + DMAppId + "]: " + err, {dmappID: DMAppId}));
                        reject();
                    });
            })
            .catch(() => {
                dmapplog.error(logger.formatLogMsg("Failed to create new TimeSeries!"));
                resolve();
            });
    });
}

/* stop a DMApp tracker */
function stopDMApp(data) {

    var DMAppId = data.DMAppId;

    // delete database
    return new Promise((resolve, reject) => {
        websocket.leaveRoom(DMAppId);
        timeSeries.deleteSeries(DMAppId)
            .then(() => {
                apilog.info(logger.formatLogMsg("Deleted time series for DMAppp [" + DMAppId + "]", {dmappID: DMAppId}));
            })
            .catch(err => {
                apilog.error(logger.formatLogMsg("FAILED to delete time series for DMAapp [" + DMAppId + "]", {dmappID: DMAppId}));
                reject();
            }).then(() => {
            backgroundTask.cancel(DMAppId,
                () => {
                    apilog.info(logger.formatLogMsg("Stopped background tasks for DMApp " + DMAppId, {dmappID: DMAppId}));
                    resolve();
                }, (err) => {
                    apilog.error(logger.formatLogMsg("Error stopping background task for DMApp " + DMAppId + ": " + err, {dmappID: DMAppId}));
                    reject();
                });
        });
    });
}

// ****************************
// Background Task Algorithms *
// ****************************
// Gets the DMApp data, finds the component priority range, divides the
// range into several sections (by default PRIORITY_LEVELS=3).
// returns an array of priority levels >=1 (1=highest) with n subarray of
// components for each level sorted by real priority.
function prepDMAppData(data) {

    var components = data.components;
    var numComponents = Object.keys(components).length;

    // find priority range
    var min=undefined, max=0;
    for (var component in components) {
        var priority = components[component].priority;
        if (min === undefined || priority < min) {
            min = priority;
        }
        if (priority > max) {
            max = priority;
        }
    }

    // define high/mid/low priority sections
    var levels = data.priorityLevels;
    if (levels === undefined) {
        levels = PRIORITY_LEVELS;
    }
    if (levels > numComponents) {
        // making sure we don't have more priority levels than components...
        levels = numComponents;
    }

    // assign priority levels
    var diff = (max - min + 1)/levels;
    var keys = Object.keys(components).sort(
        (a,b) => {
            return components[b].priority - components[a].priority;
        });
    var results = [];
    for (var i=1; i<=levels; i++) {
        results[i] = [];
    }
    for (var key in keys) {
        var level = levels - parseInt((components[keys[key]].priority - min) / diff);
        results[level].push(keys[key]);
    }

    return results;
}

function evaluateDMApp(attrs) {

    var data = attrs.data;
    var options = attrs.options;

    return new Promise((resolve, reject) => {

        dmapplog.debug(logger.formatLogMsg("Processing job for DMApp " + data.DMAppId, {dmappID: data.DMAppId}));

        // get components from database
        layoutDB.getComponents(data.contextId, data.DMAppId)
            .then(components => {

                dmapplog.debug(logger.formatLogMsg("Got layout for DMApp " + data.DMAppId, {dmappID: data.DMAppId}));

                var levels = prepDMAppData({
                    priorityLevels: data.priorityLevels,
                    components: components
                });

                // get component stats from DB
                getDMAppMetrics(data.DMAppId)
                    .then(stats => {

                        dmapplog.debug(logger.formatLogMsg("Processing data for DMApp " + data.DMAppId, {dmappID: data.DMAppId}));

                        if (Object.keys(stats).length == 0) {
                            // nothing to do if we don't have any stats yet...

                            // enforce inactivity pruning
                            if (options.startedRunning &&
                                (Date.now() - options.lastActive) >= DEAD_INACTIVITY_PERIOD) {

                                // inactive for too long, kill this task!
                                dmapplog.error(logger.formatLogMsg("No activity in DMApp for more than defined inactivity timeout, pruning it!", {dmappID: data.DMAppId}));
                                stopDMApp(data);
                            }
                            if (!options.startedRunning &&
                                (Date.now() - options.lastActive) >= NEVER_STARTED_PERIOD) {

                                // this DMApp did not do anything we care about for 25 hours so we stop tracking is
                                dmapplog.error(logger.formatLogMsg("DMApp did no do anything for more than defined startup period since it was created, pruning it!", {dmappID: data.DMAppId}));
                                stopDMApp(data);
                            }

                            resolve();
                            return;
                        }

                        // mark started
                        options.startedRunning = true;
                        options.lastActive = Date.now();

                        // enforce grace period
                        if (options.grace > 0) {
                            dmapplog.info(logger.formatLogMsg("Grace period [" + options.grace + "] for DMApp: " + data.DMAppId, {dmappID: data.DMAppId}));
                            options.grace--;
                            resolve();
                            return;
                        }

                        // we know the available bandwidth to fit into (we take a safety margin)
                        var hasBandwidthLimit = data.hasOwnProperty("availableBandwidth");
                        var availableBandwidth =
                            hasBandwidthLimit ? data.availableBandwidth * BANDWIDTH_LIMIT_SAFETY : -1;

                        // calculate current bandwidth usage
                        var bandwidthUsage = getBandwidthUsage(stats, false, false);
                        var maxBandwidth = getBandwidthUsage(stats, true, false);

                        dmapplog.debug(logger.formatLogMsg("[" + data.DMAppId + "]: usage: " + bandwidthUsage + " / available: " +
                            availableBandwidth, {dmappID: data.DMAppId}));

                        if (hasBandwidthLimit) {
                            bandwidthUsage += normalizeComponents(stats);
                        }

                        // is there anything we actually need to do here?
                        if (hasBandwidthLimit && bandwidthUsage <= availableBandwidth) {
                            resolve();
                            return;
                        }

                        // if we don't have a bandwidth limit but can do the max for all components, nothing to do...
                        if (!hasBandwidthLimit && bandwidthUsage / BANDWIDTH_LIMIT_SAFETY >= maxBandwidth) {
                            resolve();
                            return;
                        }

                        // go over groups in reverse order
                        for (var i = 1; i < levels.length && (!hasBandwidthLimit || bandwidthUsage > availableBandwidth); i++) {

                            // in case we don't have a specified bandwidth limit, we need to find missing bandwidth
                            // for this level
                            if (!hasBandwidthLimit) {
                                var diff = normalizeComponents(stats);
                                var missing = diff / BANDWIDTH_LIMIT_SAFETY;
                                bandwidthUsage = missing;
                                availableBandwidth = 0;
                            }

                            for (var turn = 0, shutdown = false; turn <= 1 && bandwidthUsage > availableBandwidth; turn++, shutdown = true) {
                                for (var j = levels.length - 1; j > i && bandwidthUsage > availableBandwidth; j--) {
                                    bandwidthUsage = conformComponentGroup(stats, levels[j], bandwidthUsage, availableBandwidth, shutdown);
                                }
                            }

                            // still not good? try our group now
                            if (bandwidthUsage > availableBandwidth) {
                                for (var turn = 0, shutdown = false; turn <= 1 && bandwidthUsage > availableBandwidth; turn++, shutdown = true) {
                                    bandwidthUsage = conformComponentGroup(stats, levels[i], bandwidthUsage, availableBandwidth, shutdown);
                                }
                            }
                        }

                        // ok, by now we've done the best we can so we should convert the status into an action list
                        var actions = createActionList(stats);
                        notifyActions(data.DMAppId, actions);
                        resolve();
                    })
                    .catch(err => {
                        dmapplog.error(logger.formatLogMsg("Error fetching stats so no actions to take: " + err));

                        if (Date.now() - options.lastActive >= DEAD_INACTIVITY_PERIOD) {
                            dmapplog.error(logger.formatLogMsg("Unable to fetch DMApp data for more than inactivity timeout, pruning it!"));
                            stopDMApp(data);
                        }

                        resolve();
                    });
            })
            .catch(err => {
                dmapplog.debug(logger.formatLogMsg("Error fetching DMApp data so no actions to take: " + err));

                if (Date.now() - options.lastActive >= DEAD_INACTIVITY_PERIOD) {
                    dmapplog.error(logger.formatLogMsg("Unable to fetch DMApp data for more than inactivity timeout, pruning it!"));
                    stopDMApp(data);
                }

                resolve();
            });
    });
}

// make sure all bandwidths are within normal limits
function normalizeComponents(stats) {
    var totalDiff = 0;
    for (var component in stats) {
        var stat = stats[component];

        // skip if actual usage is zero
        if (stat.videoBandwidth == 0)
            continue;
        
        var diff = stat.playingVideoBitrate - stat.videoBandwidth;
        dmapplog.trace(logger.formatLogMsg("norm: " + stat.playingVideoBitrate + "  -  " + stat.videoBandwidth + "  =  " + diff));
        if (diff > 0) {
            totalDiff += diff;
            stat.videoBandwidth = stat.playingVideoBitrate;
        }
    }
    return totalDiff;
}

// Take the available bandwidth and divide among active clients according to priorities
function conformComponentGroup(stats, group, bandwidthUsage, availableBandwith, shutdown) {

    var changed = true;
    var sortedGroup = group.concat().sort((a,b) => {return b.videoBandwidth - a.videoBandwidth;});
    while (changed && bandwidthUsage > availableBandwith) {

        changed = false;

        // go over this group
        for (var i = 0; i < sortedGroup.length && bandwidthUsage > availableBandwith; i++) {

            var id = sortedGroup[i];
            var stat = stats[id];

            // do we have stats for this component?
            if (stat === undefined)
                continue;

            // skip this component if already turned off
            if (stat.videoBandwidth == TURNEDOFF)
                continue;

            // skip this component if it has unrealistic bandwidth usage
            //if (stat.bandwidth >= MAX_REALISTIC_BANDWIDTH)
            //    continue;

            // go over them and find the highest one lower than current
            var j = 1;
            for (; j < stat.bitrates.video.length &&
                   stat.bitrates.video[j] < stat.videoBandwidth; j++);
            var diff = stat.videoBandwidth - stat.bitrates.video[j - 1];

            if (diff == 0) {
                // turn off?
                if (shutdown) {
                    diff = stat.videoBandwidth;
                    stat.videoBandwidth = TURNEDOFF;
                }
            } else {
                stat.videoBandwidth = stat.bitrates.video[j - 1];
            }
            bandwidthUsage -= diff;

            changed |= diff > 0;
        }
    }

    return bandwidthUsage;
}

// get the bandwidth usage of a DMApp
function getBandwidthUsage(stats, max, supposed) {
    var usage = 0;
    for (var id in stats) {
        if (max) {
            usage += stats[id].maxBitrate;
        } else if (supposed) {
            usage += stats[id].playingVideoBitrate + stats[id].playingAudioBitrate;
        } else {
            usage += stats[id].bandwidth;
        }
    }
    return usage;
}

function getDMAppMetrics(DMAppId) {
    return timeSeries.getMetrics(DMAppId);
}

// Create the action list JSONs for the active players
function createActionList(stats) {
    var actions = {};
    for (var component in stats) {
        var action = {
            "action": "nothing",
            "videoBitrate": stats[component].videoBandwidth
        };
        if (stats[component].videoBandwidth == TURNEDOFF) {
            action.action = ACTIONS.DISABLE;
        } else if (stats[component].videoBandwidth < stats[component].playingVideoBitrate) {
            action.action = ACTIONS.DOWNGRADE;
        } /*else if (stats[component].videoBandwidth > stats[component].playingVideoBitrate) {
         action.action = ACTIONS.UPGRADE;
         } else if (stats[component].videoBandwidth == stats[component].playingVideoBitrate) {
         action.action = ACTIONS.PRESERVE;
         } */
        actions[component] = action;
    }
    return actions;
}

// send the action lists to the proper clients
function notifyActions(DMAppId, actions) {

    if (actions === undefined) {
        dmapplog.info(logger.formatLogMsg("No actions for '" + DMAppId + "' at this time", {dmappID: DMAppId}));
        return;
    }
    var message = {};
    message[DMAppId] = {"actions":actions};
    dmapplog.info(logger.formatLogMsg(JSON.stringify(message), {dmappID: DMAppId}));
    websocket.pushNotice(DMAppId, message);
}
//</editor-fold>

//<editor-fold desc="Initializers">
//**********************
//* Initializers
//**********************
/** Consul **/
function initConsul(host, local) {
    if (local === undefined) {
        var consulUrl = url.parse(host);
        var consulConfig = {
            host: consulUrl.hostname,
            port: consulUrl.port,
            secure: consulUrl.protocol === 'https:',
            rejectUnauthorized: false
        };

        log.info(logger.formatLogMsg("Trying to establish Consul connection at: " + JSON.stringify(consulConfig)));
        consulService = require('consul')(consulConfig);
    }
}

// resolve a service using Consul
function consulResolve(service) {

    return new Promise((resolve, reject) => {
        if (service.split(":").length > 1) {
            log.warn(logger.formatLogMsg("Not a consul service name so skipping consul..."));
            resolve(service);
            return;
        }

        // if we're not using consul, just return...
        if (consulService === undefined) {
            log.warn(logger.formatLogMsg("Apparently Consul is not defined so not using it..."));
            resolve (service);
            return;
        }

        consulService.catalog.service.nodes(service, function (err, res) {
            if (err || res.length === 0) {
                log.error(logger.formatLogMsg("Error resolving service '" + service + "' via consul: " + err));
                reject();
                return;
            }

            resolve(res[0].ServiceAddress + ":" + res[0].ServicePort);
        });
    });
}

/** Socket.io **/
function initWebSocket(url) {
    websocket.init(url);
    websocket.onInit('initDMApp', initializeDMApp);
    websocket.onStop('stopDMApp', stopDMApp);
}

/** Web Service **/
function initServer(port, app) {
     if (port) {
         PORT = port;
     }
     server = http.createServer(app);
     server.listen(PORT, '0.0.0.0', function () {
         log.info(logger.formatLogMsg(`Listening on port ${PORT}`));
     });
}
//</editor-fold>
