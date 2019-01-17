# 2-IMMERSE Bandwidth Orchestration Service

When running multiple video players within multiple clients, client-side ABR logic might not be enough
to ensure playback quality. When the various clients all belong to a single entity with quality
requirements and player priorities, there's a need for centralized bandwidth management. This is what
the **Bandwidth Orchestration Service (BOS)** aims to do.

### Initializing a DMApp:

When initializing a new DMApp instance, BOS needs to be notified so it can be aware of the video
components within the DMApp and prepare the appropriate data structures. BOS also launches a background
task that will monitor the usage data that is reported (see below) by the DMApp's components and calculate
action recommendations.

Background tasks are created and executed using the [Agenda](https://github.com/agenda/agenda) lightweight
job scheduler. Agenda uses MongoDB to create queues and persis jobs. Thus, even if the service crashes for
some reason, once a new instance is started, all the jobs are picked up and continue running. Jobs can
also be processed by multiple BOS instance to spread the processing load.

Initializing a DMApp is done by posting to '**/init**':

```javascript
{
  "DMAppId": "dmapp1",
  "contextId": "context1",
  "availableBandwidth": 6000000,
  "priorityLevels": 3
}
```

To remove a DMApp, send a **DELETE** request to '**/stop/{DMAppId}**'.

The service is also connected to the websocket service which is how it integrates with the LayoutService now.
To start tracking a DMApp, send an init message to the "bandwidth.orchestration" room:

```javascript
{
    "init": {
        "DMAppId": "dmapp1",
        "contextId": "context1",
        "availableBandwidth": 6000000,
        "priorityLevels": 3
    }
}
```

And to stop tracking send a stop message:
```javascript
{
    "stop": "dmapp1"
}
```


### Tracking components' bandwidth usage:

The [MPEG DASH SAND](http://dashif.org/wp-content/uploads/2017/01/SAND-Whitepaper-Dec13-final.pdf)
standard aims to enable **"Server and Network Assisted DASH"** by defining message formats and usage
cases for such management to help take better advantage of multi-client knowledge and network elements
to improve DASH performance. SAND defines all the metrics as optional and allows for custom metrics as
well.

The SANDPlayer component of the [Bandwidth Orchestration Client](https://gitlab-ext.irt.de/2-immerse/bandwidth-orchestration-client)
uses the SAND specifications to send usage data to BOS. BOS then tries to filter out bad data such as
data that indicated using segments from the browser's cache (unrealistically high bandwidth usage) and
pushes good data into a TimeSeries DB. We use InfluxDB.

As there is currently no server-side DASH manifest parser, we rely on the client-side manifest parsing
to get the available audio/video bitrates for each player. These are also stored in InfluxDB.


## Algorithm

The background tracking task runs every 5 seconds by default.

BOS assumes that if no data has been received, the DMApp hasn't started running yet. It will, therefor,
not do anything until that happens. Once data starts coming in, BOS will give the DMApp a grace period of
5 monitoring periods as defined above.

As calculating the optimal selection of player bitrates is a very hard problem (NP-Complete and maps to
the [0-1 Quadratic Knapsack Problem](https://en.wikipedia.org/wiki/Quadratic_knapsack_problem)), there's no
known efficient solution for it. In fact, the fastest algorithm developed to date (only 2 algorithms
have ever been developed for this problem) can take hours to compute the optimal solution.

Thus, we have to use a fast solution that will give a best-effort non-optimal solution. BOS uses a simple
greedy solver to give quick solution. The greedy solution has been mathematically proven to be a 2
approximation of the optimal solution.

#### Case 1: We are given a target bandwidth with the "availableBandwidth" field in the init request:

We start by dividing the components into priority levels according to their priorities. By default, we
use 3 priority levels, however this can be changed by adding the "priorityLevels" field to the init
request.

We then Go over the levels from the highest to the lowest and try to satisfy it by reducing the bitrates
of the lower levels. We go over the lower levels from lowest to highest and try to reduce the chosen
bitrate for each component by one degree (from the bitrates list of that component) to see if we can
reach the available bandwidth as specified in the init request. We keep doing this until we either reach
our goal or have lowered all the components in that level to their lowest bitrate.

We continue to the next level and so on until we've done all the levels. If we still haven't reached out
goal, we go over the lower levels from lowest to highest again and try to disable components. If We went
over ALL the lower levels and still haven't reached our goal, we start doing the same to the current
level.

At this point, we either disabled all the components, or have reached our goal. In case of the latter, we
simple move of to the next priority level and do the same for it.

It can immediately be seen that this solution is far from the optimized solution. However, it IS simple
and quick, and takes component priorities into considerations.

#### Case 2: The "availableBandwidth" is not known:

In this case we first compute the maximum bandwidth required for all the components. If the currently
used bandwidth is equal or greater than this maximum, all is well.

Now, we define our "availableBandwidth" to be the currently used bandwidth (this is reasonable because
we can assume the component would have used more bandwidth is more was available to them...).

Next we iterate over the priority groups as above, but this time, for each group we try to satisfy, we
compute the "missing" bandwidth needed for all of it's components to play the maximum bitrate and then
try to free up that bandwidth at the expense of the lower levels' components in the same way as above.

We repeat the process for all the groups.


### Action recommendations:

Once the service computes some action recommendations for a DMApp, it puts a message on the 
websocket service in the "*bandwidth.orchestration.{DMAppId}*" room. For "dmapp1", the message is
posted in room "*bandwidth.orchestration.dmapp1*" and looks like this:

```javascript
{
  "dmapp1": {
    "actions": {
      "comp1":{
        "actions": "preserve",
        "videoBitrate": 100000
      },
      "comp2":{
        "action": "downgrade",
        "priority": 50000
      },
      "comp3":{
        "action": "disable",
        "priority": 50000
      }
    }
  }
}
```

Where available actions are currently "preserve", "downgrade", and "disable". "preserve" means to
keep the current bitrate, "downgrade" means the bitrate should be lowered to the suggested one, and
"disable" means the component should be stopped to clear out bandwidth to higher priority components.

### Limitations:

* As said above, this algorithm is far from the optimized solution but os the best we can do for a
real-time algorithm.

* Component bandwidth is averaged over the past 5 seconds to try and smooth out sudden spikes. However,
if using the SANDPlayer, since the bandwidth measurement is a best-effort approximation (see the client's
readme for details), the data provided is often unstable and can lead to jumpy actions.

## Helper API calls:

* GET **/status**

This call returns a list of all tracked DMApps:
```javascript
[
    {
        "name": "dmapp1",
        "type": "evaluateDMApp",
        "contextId": "context1",
        "DMAppId": "dmapp1",
        "grace": 3,
        "startedRunning": false,
        "lastActive": 1509466822845
    },
    {
        "name": "dmapp2",
        "type": "evaluateDMApp",
        "contextId": "context1",
        "DMAppId": "dmapp2",
        "grace": 3,
        "startedRunning": false,
        "lastActive": 1509466829100
    }
]
```

* POST **/clean/All/The/Stuff**

This call will wipe EVERYTHING! All the tracked DMApps will be removed, all the InfluxDB databases will be
purged and all the websocket-service per-DMApp rooms will be left!

***USE WITH EXTREME CAUTION!!***

output:
```javascript
[
 "removed 2 job(s)"
]
```

## Usage:

```
  Usage: node index.js [options]


  Options:

    -p, --port <port>          Set listener port
    -i, --influx <host:port>   Set InfluxDB host (service name for Consul)
    -w, --websocket <url>      Set WebSocket server URL (service name for Consul)
    -m, --mongodb <host:port>  Set MongoDB host (service name for Consul)
    -c, --consul-host <host>   Consul host (default = https://consul.service.consul:8500)
                               If 'http' is given, the default will be used but with 'http'
    -l, --local                Run standalone service with no Consul resolving
    -t, --interval             Background task interval in seconds
    -b, --max-bandwidth        Maximum realistic bandwidth to filter browser caching
    -h, --help                 output usage information
```

## Licence and Authors

All code and documentation is licensed by the original author and contributors under the Apache License v2.0:

* Cisco an/or its affiliates

<img src="https://2immerse.eu/wp-content/uploads/2016/04/2-IMM_150x50.png" align="left"/><em>This project was originally developed as part of the <a href="https://2immerse.eu/">2-IMMERSE</a> project, co-funded by the European Commission’s <a hef="http://ec.europa.eu/programmes/horizon2020/">Horizon 2020</a> Research Programme</em>

See AUTHORS file for a full list of individuals and organisations that have
contributed to this code.
