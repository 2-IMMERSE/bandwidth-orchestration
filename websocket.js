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
const sockio      = require('socket.io-client');
const log4js      = require('log4js');
const logger      = require('./logger.js');

var WEBSOCKET_HOST = 'https://localhost';
var WEBSOCKET_PORT = 443;
var WEBSOCKET_ROOM = 'bandwidth';
var WEBSOCKET_NAME = 'orchestration';

// A WebSocket service client
var WebSocket = function() {
    this.socket = undefined;

    // Events we listen for
    this.events = {
        'init': {},
        'stop': {}
    };
    this.rooms = {};

    log4js.configure(logger.config);
    this.log = log4js.getLogger('websocket');
}

// Connect to the websocket service
WebSocket.prototype.init = function(host) {
    if (host) {
        var parts = host.split(":");
        WEBSOCKET_HOST = parts[0];
        if (parts[1]) {
            WEBSOCKET_PORT = parts[1];
        }
    }

    // define the path to the websocket service for layout service information
    url = `${WEBSOCKET_HOST}:${WEBSOCKET_PORT}/layout`;
    if (!url.startsWith("http")) {
        url = "http://" + url;
    }

    // create the socket.io connection
    this.log.info(logger.formatLogMsg(`Connecting to WebSocket server at '${url}'`));
    this.socket = sockio.connect(`${url}`,{timeout: 2000});
    this.socket.on('connect', () => {
        this.log.info(logger.formatLogMsg(`Connected to WebSocket server at '${WEBSOCKET_HOST}:${WEBSOCKET_PORT}'`));

        // join room
        this.socket.emit("JOIN", JSON.stringify({room: `${WEBSOCKET_ROOM}.${WEBSOCKET_NAME}`, name: "BOS"}));
        this.log.info(logger.formatLogMsg(`WebSocket joined '${WEBSOCKET_ROOM}.${WEBSOCKET_NAME}'`));
    });

    this.socket.on('EVENT', (data) => {
        this.log.info(logger.formatLogMsg('received EVENT :' + JSON.stringify(data)));

        // run init callbacks
        if (data.message.hasOwnProperty('init')) {
            for (var cb in this.events.init) {
                this.events.init[cb](data.message.init)
                    .catch(err => {});
            }
            return;
        }

        // run stop callbacks
        if (data.message.hasOwnProperty('stop')) {
            for (var cb in this.events.stop) {
                this.events.stop[cb](data.message.stop)
                .catch(err => {});
            }
        }
    });

    this.socket.on('disconnect', () => {
        this.log.info(logger.formatLogMsg("Disconnected !"));
    });

    this.socket.on('error', err => {
        this.log.error(logger.formatLogMsg("WebSocket error! " + err));
    });
};

// The client is healthy if it is connected
WebSocket.prototype.health = function() {
    return this.socket.connected;
}

// handle an 'init' message from the layout service
WebSocket.prototype.onInit = function(name, cb) {
    this.events.init[name] = cb;
};

// remove the 'init' event handler for cleanup
WebSocket.prototype.removeInit = function(name) {
    delete this.events.init[name];
};

// handle a 'stop' message from the layout service
WebSocket.prototype.onStop = function(name, cb) {
    this.events.stop[name] = cb;
};

// remove the 'stop' event handler for cleanup
WebSocket.prototype.removeStop = function(name) {
    delete this.events.stop[name];
};

// join a room for a specific DMApp
WebSocket.prototype.joinRoom = function(name) {
    this.socket.emit("JOIN", JSON.stringify({room: `${WEBSOCKET_ROOM}.${WEBSOCKET_NAME}.${name}`, name: "BOS"}));
    this.rooms[name] = 1;
};

// leave a DMApp specific room
WebSocket.prototype.leaveRoom = function(name) {
    this.socket.emit("LEAVE", JSON.stringify({room: `${WEBSOCKET_ROOM}.${WEBSOCKET_NAME}.${name}`, name: "BOS"}));
    delete this.rooms[name];
};

// leave ALL the DMApp rooms
WebSocket.prototype.purge = function() {
    for (var room in this.rooms) {
        this.leaveRoom(room);
    }
};

// send a message to a given room
WebSocket.prototype.pushNotice = function(name, data) {

    // do we need to join a room before pushing the message?
    if (!(name in this.rooms)) {
        this.joinRoom(name);
    }
    this.socket.emit("NOTIFY", JSON.stringify({room: `${WEBSOCKET_ROOM}.${WEBSOCKET_NAME}.${name}`, sender: "BOS", message: data}));
};

// close the websocket client connection
WebSocket.prototype.close = function() {
    this.socket.close();
}

module.exports = new WebSocket();
