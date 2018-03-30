/* ============================================================
 * node-okex-api
 https://github.com/ZhiweiWang/node-okex-api
 * ============================================================
 * Copyright 2018-, Zhiwei Wang
 * Released under the GPL 3.0 License
 * ============================================================ */

module.exports = (function() {
    "use strict";
    const WebSocket = require("ws");
    const request = require("request");
    const crypto = require("crypto");
    const file = require("fs");
    const stringHash = require("string-hash");
    const md5 = require("md5");
    const _ = require("underscore");
    const util = require("util");
    const VError = require("verror");
    const base = "http://api.zb.com/data/v1/";
    const stream = "wss://api.zb.com:9999/websocket";
    const userAgent =
        "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/39.0.2171.71 Safari/537.36";
    const contentType = "text/javascript";
    let subscriptions = {};
    const default_options = {
        timeout: 30000,
        reconnect: true,
        verbose: false,
        test: false,
        log: function() {
            console.log(Array.prototype.slice.call(arguments));
        }
    };
    let options = default_options;
    let socketHeartbeatInterval;

    const publicRequest = function(method, params, callback) {
        var functionName = "publicRequest()";

        if (!_.isObject(params)) {
            var error = new VError(
                "%s second parameter %s must be an object. If no params then pass an empty object {}",
                functionName,
                params
            );
            return callback(error);
        }

        if (!callback || typeof callback != "function") {
            var error = new VError(
                "%s third parameter needs to be a callback function with err and data parameters",
                functionName
            );
            return callback(error);
        }

        var url = `${base}${method}`;

        var req_options = {
            url: url,
            method: "GET",
            headers: {
                "User-Agent": userAgent,
                "Content-type": contentType
            },
            timeout: options.timeout,
            qs: params,
            json: {} // request will parse the json response into an object
        };

        var requestDesc = util.format(
            "%s request to url %s with parameters %s",
            req_options.method,
            req_options.url,
            JSON.stringify(params)
        );

        executeRequest(req_options, requestDesc, callback);
    };

    const executeRequest = function(req_options, requestDesc, callback) {
        var functionName = "executeRequest()";

        request(req_options, function(err, response, data) {
            var error = null, // default to no errors
                returnObject = data;

            if (err) {
                error = new VError(err, "%s failed %s", functionName, requestDesc);
                error.name = err.code;
            } else if (response.statusCode < 200 || response.statusCode >= 300) {
                error = new VError(
                    "%s HTTP status code %s returned from %s",
                    functionName,
                    response.statusCode,
                    requestDesc
                );
                error.name = response.statusCode;
            } else if (req_options.form) {
                try {
                    returnObject = JSON.parse(data);
                } catch (e) {
                    error = new VError(e, "Could not parse response from server: " + data);
                }
            } else if (req_options.json && !_.isObject(data)) {
                // if json request was not able to parse json response into an object
                error = new VError(
                    "%s could not parse response from %s\nResponse: %s",
                    functionName,
                    requestDesc,
                    data
                );
            }

            if (_.has(returnObject, "error_code")) {
                var errorMessage = mapErrorMessage(returnObject.error_code);

                error = new VError(
                    '%s %s returned error code %s, message: "%s"',
                    functionName,
                    requestDesc,
                    returnObject.error_code,
                    errorMessage
                );

                error.name = returnObject.error_code;
            }

            callback(error, returnObject);
        });
    };
    /**
     * Maps the OKEX error codes to error message
     * @param  {Integer}  error_code   OKEX error code
     * @return {String}                error message
     */
    const mapErrorMessage = function(error_code) {
        var errorCodes = {
            1000: "调用成功",
            1001: "一般错误提示",
            1002: "内部错误",
            1003: "验证不通过",
            1004: "资金安全密码锁定",
            1005: "资金安全密码错误，请确认后重新输入。",
            1006: "实名认证等待审核或审核不通过",
            1009: "此接口维护中",
            2001: "人民币账户余额不足",
            2002: "比特币账户余额不足",
            2003: "莱特币账户余额不足",
            2005: "以太币账户余额不足",
            2006: "ETC币账户余额不足",
            2007: "BTS币账户余额不足",
            2009: "账户余额不足",
            3001: "挂单没有找到",
            3002: "无效的金额",
            3003: "无效的数量",
            3004: "用户不存在",
            3005: "无效的参数",
            3006: "无效的IP或与绑定的IP不一致",
            3007: "请求时间已失效",
            3008: "交易记录没有找到",
            4001: "API接口被锁定或未启用",
            4002: "请求过于频繁"
        };

        if (!errorCodes[error_code]) {
            return "Unknown ZB error code: " + error_code;
        }

        return errorCodes[error_code];
    };
    ////////////////////////////
    // reworked Tuitio's heartbeat code into a shared single interval tick
    const noop = function() {};
    const socketHeartbeat = function() {
        // sockets removed from `subscriptions` during a manual terminate()
        // will no longer be at risk of having functions called on them
        for (let endpointId in subscriptions) {
            const ws = subscriptions[endpointId];
            if (ws.isAlive) {
                ws.isAlive = false;
                if (ws.readyState === WebSocket.OPEN) ws.ping(noop);
            } else {
                if (options.verbose) options.log("Terminating inactive/broken WebSocket: " + ws.endpoint);
                if (ws.readyState === WebSocket.OPEN) ws.terminate();
            }
        }
    };
    const _handleSocketOpen = function(opened_callback) {
        this.isAlive = true;
        if (Object.keys(subscriptions).length === 0) {
            socketHeartbeatInterval = setInterval(socketHeartbeat, 30000);
        }
        subscriptions[this.endpoint] = this;
        if (typeof opened_callback === "function") opened_callback(this.endpoint);
    };
    const _handleSocketClose = function(reconnect, code, reason) {
        delete subscriptions[this.endpoint];
        if (Object.keys(subscriptions).length === 0) {
            clearInterval(socketHeartbeatInterval);
        }
        options.log(
            "WebSocket closed: " + this.endpoint + (code ? " (" + code + ")" : "") + (reason ? " " + reason : "")
        );
        if (options.reconnect && this.reconnect && reconnect) {
            if (parseInt(this.endpoint.length, 10) === 60) options.log("Account data WebSocket reconnecting...");
            else options.log("WebSocket reconnecting: " + this.endpoint + "...");
            try {
                reconnect();
            } catch (error) {
                options.log("WebSocket reconnect error: " + error.message);
            }
        }
    };
    const _handleSocketError = function(error) {
        // Errors ultimately result in a `close` event.
        // see: https://github.com/websockets/ws/blob/828194044bf247af852b31c49e2800d557fedeff/lib/websocket.js#L126
        options.log(
            "WebSocket error: " +
                this.endpoint +
                (error.code ? " (" + error.code + ")" : "") +
                (error.message ? " " + error.message : "")
        );
    };
    const _handleSocketHeartbeat = function() {
        this.isAlive = true;
    };
    const subscribe = function(endpoint, callback, reconnect = false, opened_callback = false) {
        if (options.verbose) options.log("Subscribed to " + endpoint);
        const ws = new WebSocket(stream);
        ws.reconnect = options.reconnect;
        ws.endpoint = endpoint;
        ws.isAlive = false;
        ws.on("open", _handleSocketOpen.bind(ws, opened_callback));
        ws.on("pong", _handleSocketHeartbeat);
        ws.on("error", _handleSocketError);
        ws.on("close", _handleSocketClose.bind(ws, reconnect));
        ws.on("message", function(data) {
            try {
                callback(JSON.parse(data));
            } catch (error) {
                options.log("Parse error: " + error.message);
            }
        });
        return ws;
    };
    const subscribeCombined = function(streams, callback, reconnect = false, opened_callback = false) {
        const queryParams = streams.join("/");
        const ws = new WebSocket(stream);
        ws.reconnect = options.reconnect;
        ws.endpoint = stringHash(queryParams);
        ws.streams = streams;
        ws.isAlive = false;
        if (options.verbose) options.log("CombinedStream: Subscribed to [" + ws.endpoint + "] " + queryParams);
        ws.on("open", _handleSocketOpen.bind(ws, opened_callback));
        ws.on("pong", _handleSocketHeartbeat);
        ws.on("error", _handleSocketError);
        ws.on("close", _handleSocketClose.bind(ws, reconnect));
        ws.on("message", function(data) {
            try {
                callback(JSON.parse(data));
            } catch (error) {
                options.log("CombinedStream: Parse error: " + error.message);
            }
        });
        return ws;
    };
    const addChannel = function(endpoint) {
        const ws = subscriptions[endpoint];
        if (ws.hasOwnProperty("streams")) {
            for (let channel of ws.streams) {
                let channelobj = { event: "addChannel", channel };
                ws.send(JSON.stringify(channelobj));
            }
        } else {
            let channel = { event: "addChannel", channel: endpoint };
            ws.send(JSON.stringify(channel));
        }
    };

    const isArrayUnique = function(array) {
        let s = new Set(array);
        return s.size == array.length;
    };
    ////////////////////////////
    return {
        candlesticks: function(market, type, callback, options = { size: 500 }) {
            if (!callback) return;
            let params = Object.assign({ market, type }, options);

            publicRequest("kline", params, callback);
        },
        setOption: function(key, value) {
            options[key] = value;
        },
        options: function(opt, callback = false) {
            if (typeof opt === "string") {
                // Pass json config filename
                options = JSON.parse(file.readFileSync(opt));
            } else options = opt;
            if (typeof options.recvWindow === "undefined") options.recvWindow = default_options.recvWindow;
            if (typeof options.useServerTime === "undefined") options.useServerTime = default_options.useServerTime;
            if (typeof options.reconnect === "undefined") options.reconnect = default_options.reconnect;
            if (typeof options.test === "undefined") options.test = default_options.test;
            if (typeof options.log === "undefined") options.log = default_options.log;
            if (typeof options.verbose === "undefined") options.verbose = default_options.verbose;

            if (callback) callback();
        },
        websockets: {
            subscribe: function(url, callback, reconnect = false) {
                return subscribe(url, callback, reconnect);
            },
            subscriptions: function() {
                return subscriptions;
            },
            trades: function trades(symbols, callback) {
                let reconnect = function() {
                    if (options.reconnect) trades(symbols, callback);
                };

                let subscription = undefined;
                if (Array.isArray(symbols)) {
                    if (!isArrayUnique(symbols)) throw Error('trades: "symbols" cannot contain duplicate elements.');
                    let streams = symbols.map(function(symbol) {
                        return symbol.toLowerCase() + "_trades";
                    });
                    subscription = subscribeCombined(streams, callback, reconnect, addChannel);
                } else {
                    let symbol = symbols;
                    subscription = subscribe(symbol.toLowerCase() + "_trades", callback, reconnect, addChannel);
                }
                return subscription.endpoint;
            }
        }
    };
})();
