'use strict';

/*-------------------------------------------------------------------------------
* Name:        logger.js
* Purpose:

* Author:      2-IMMERSE Team
* Created:     2016/10/20
* History:     2016/10/20 - Initial commit
*
* Copyright 2018 Cisco and/or its affiliates

* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at

* http://www.apache.org/licenses/LICENSE-2.0

* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*-------------------------------------------------------------------------------*/

exports = module.exports = new Logger();
exports.Logger = Logger;

var LogLevels = {
    "INFO": true,
    "WARN": true,
    "ERROR": true,
    "DEBUG": true
};

function Logger() {
  let source = process.env.LOG_NAME || 'BandwidthOrchestration';

  this.config = {
    appenders: [
        {
          type: "console",
          layout: {
            type: 'pattern',
            pattern: "2-Immerse subSource:%c level:%p %m sourcetime:%d{ISO8601_WITH_TZ_OFFSET} source:"
          }
        }
      ],
      "levels": {
        "index": "INFO",
        "component": "INFO",
        "dmapp": "DEBUG",
        "influxdb": "INFO",
        "agenda": "INFO",
        "restapi": "DEBUG",
        "websocket": "INFO",
        "mongodb": "DEBUG"
      },
      replaceConsole: true
    };
}

Logger.prototype.configure = function(label, level) {

  this.config.appenders[0].layout.pattern += label;
  if (! (level in LogLevels)) {
    level = "INFO";
  }

  Object.keys(this.config.levels).forEach((key) => {
    this.config.levels[key] = level;
  });

};

Logger.prototype.formatLogMsg = function(msg, ctx) {
  var prefix = "";

  if  (ctx != undefined) {
    if (typeof(ctx) == "string") {
      var err = new Error();
      console.error("formatLogMsg called with string argument: " +  err.stack) ;
    } else {
      Object.keys(ctx).forEach(function(key) {
        if (ctx.hasOwnProperty(key)) {
          prefix += " " + key + ":" + ctx[key] + " ";
        }
      });
    }
  }

  if (msg instanceof Error) {
    msg = msg.stack;
  }

  return (prefix + "logmessage:'" + msg.toString().replace(/'/g, "\"") + "'").replace(/(\r\n|\n|\r)/gm, " "); // strip out any line breaks
};

Logger.prototype.formatLogReqMsg = function(req) {
  return this.formatLogAPIMsg(req.method, req.url, JSON.stringify(req.body));
}

Logger.prototype.formatLogAPIMsg = function(method, path, body) {
  return "api:" + method + ": " + path + " body:" + body;
};