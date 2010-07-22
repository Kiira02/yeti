var http = require("http");
var EventEmitter = require("events").EventEmitter;

function responseEventForRequest (req) {
    var event = new EventEmitter();
    req.addListener("response", function (response) {
        response.setEncoding("utf8");
        var data = "";
        response.addListener("data", function (chunk) {
            data += chunk;
        });
        response.addListener("end", function () {
            if (response.headers["content-type"] === "application/json") {
                data = JSON.parse(data);
            }
            event.emit("response", response, data);
        });
    });
    req.connection.addListener("error", function (err) {
        event.emit("error", err);
    });
    req.end();
    return event;
}

function httpRequest (d) {
// host, port, path, secure, method, body) {

    d.method = d.method || "GET";
    d.headers = d.headers || {};
    d.headers["host"] = d.host;

    if ("object" === typeof d.body) {
        d.body = JSON.stringify(d.body);
        d.headers["content-type"] = "application/json";
    }

    if (d.body) {
        d.headers["content-length"] = d.body.length;
    }

    var req = http.createClient(
        d.port || (d.secure ? 443 : 80),
        d.host,
        d.secure
    ).request(d.method, d.path, d.headers);

    req.write(d.body);

    return responseEventForRequest(req);
}

exports.request = httpRequest;