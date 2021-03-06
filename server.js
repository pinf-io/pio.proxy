
const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs-extra");
const URL = require("url");
const QUERYSTRING = require("querystring");
const EVENTS = require("events");
const HTTP = require('http');
const DEEPMERGE = require("deepmerge");
const HTTP_PROXY = require("http-proxy");
const CRYPTO = require("crypto");

function main(callback) {

    var pioConfig = FS.readJsonSync(PATH.join(__dirname, "../.pio.json"));
//console.log(JSON.stringify(pioConfig, null, 4));

    ASSERT.equal(typeof pioConfig.env.PORT, "number");

    var vhosts = {};
    for (var pluginId in  pioConfig["config.plugin"]) {
        for (var hostname in pioConfig["config.plugin"][pluginId]) {
            if (pioConfig["config.plugin"][pluginId].vhosts) {
                var _vhosts = pioConfig["config.plugin"][pluginId].vhosts;
                for (var host in _vhosts) {
                    if (typeof _vhosts[host] === "string") {
                        _vhosts[host] = {
                            "target": _vhosts[host]
                        };
                    }
                }
                vhosts = DEEPMERGE(vhosts, _vhosts);
            }
        }
    }
    console.log("vhosts", JSON.stringify(vhosts, null, 4));

    var requestCount = 0;

    var proxy = HTTP_PROXY.createProxyServer({});
    var server = HTTP.createServer(function(req, res) {
        function respond500(err) {
            console.error("error request", req.url);
            console.error(err.stack);
            res.writeHead(500);
            return res.end("Internal server error!");
        }
        var urlParts = URL.parse(req.url);
        var qs = urlParts.query ? QUERYSTRING.parse(urlParts.query) : {};


        if (urlParts.path === "/_internal_status") {

            if (!req.headers["x-auth-token"]) {
                return next();
            }
            if (req.headers["x-auth-token"] !== pioConfig.config["pio.service"].config.internalStatusAuthToken) {
                return next(new Error("'x-auth-token' is invalid"));
            }

            var payload = {
                process: {
                    memoryUsage: process.memoryUsage()
                },
                server: {
                    requestCount: requestCount
                }
            };

            return res.end(JSON.stringify(payload, null, 4));
        }

        requestCount += 1;


        var host = (req.headers.host && req.headers.host.split(":").shift()) || null;
        if (!host) {
            res.writeHead(404);
            console.error("Virtual host '" + host + "' not found!", req.url, req.headers);
            return res.end("Virtual host '" + host + "' not found!");
        }
        var vhostId = host;
        if (!vhosts[host]) {
            for (var rule in vhosts) {
                if (/^\*/.test(rule)) {
                    if (host.substring(host.length-rule.length+1) === rule.substring(1)) {
                        vhostId = rule;
                        break;
                    }
                }
            }
            if (vhostId === host) {
                res.writeHead(404);
                console.error("Virtual host '" + host + "' not found!", req.url, req.headers);
                return res.end("Virtual host '" + host + "' not found!");
            }
        }

        var origin = null;
        if (req.headers.origin) {
            origin = req.headers.origin;
        } else
        if (req.headers.host) {
            origin = [
                (pioConfig.env.PORT === 443) ? "https" : "http",
                "://",
                req.headers.host
            ].join("");
        }
        res.setHeader("Access-Control-Allow-Methods", "GET");
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Cookie");
        if (req.method === "OPTIONS") {
            return res.end();
        }

        try {
            // @see http://stackoverflow.com/a/19524949/330439
            var ip =
                req.headers['x-forwarded-for'] || 
                req.connection.remoteAddress || 
                req.socket.remoteAddress ||
                req.connection.socket.remoteAddress;
            req.headers['x-forwarded-for'] = ip + (
                req.headers['x-forwarded-for'] ?
                    ", " + req.headers['x-forwarded-for'] :
                    ""
            );

//            console.log("Proxy request", req.url, "for", "http://" + vhosts[vhostId].target);

            return proxy.web(req, res, {
                target: "http://" + vhosts[vhostId].target
            }, function(err) {
                if (err.code === "ECONNREFUSED") {
                    res.writeHead(502);
                    return res.end("Bad Gateway");
                }
                return respond500(err);
            });
        } catch(err) {
            return respond500(err);
        }
    });
    var httpServer = server.listen(pioConfig.env.PORT, "0.0.0.0");
    console.log("Listening on: http://0.0.0.0:" + pioConfig.env.PORT);
    console.log("Instance identity: " + "http://" + pioConfig.config["pio"].hostname + ":" + pioConfig.env.PORT + "/.instance-id/" + pioConfig.config["pio"].instanceId);

    return callback(null, {
        api: {
            shutdown: function(callback) {
                return httpServer.close(callback);
            }
        }
    });
}


if (require.main === module) {
    try {
        return main(function(err) {
            if (err) {
                console.error(err.stack);
                return process.exit(1);
            }
            // Continue running server.
        });
    } catch(err) {
        console.error(err.stack);
        return process.exit(1);
    }
}

