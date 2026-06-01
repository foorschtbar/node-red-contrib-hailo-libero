const axios = require("axios");
const wrapper = require("axios-cookiejar-support").wrapper;
const CookieJar = require("tough-cookie").CookieJar;

module.exports = function (RED) {
    function HailoLiberoDeviceNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.host = config.host;
        node.port = config.port;
        node.protocol = config.protocol;
        // debug flag from config (checkbox)
        node.debugEnabled = !!config.debug;
        node.keepLoggedIn = config.keepLoggedIn !== false; // default true
        node.pin = node.credentials.pin;

        node.loggedIn = false;
        node.loggingIn = false;
        node.lastLogin = 0;

        node.jar = new CookieJar();
        node.client = createClient();

        function createClient() {
            const client = wrapper(
                axios.create({
                    baseURL: `${node.protocol}://${node.host}:${node.port}`,
                    jar: node.jar,
                    withCredentials: true,
                    timeout: 15000
                })
            );

            if (node.debugEnabled) attachDebug(client, node);

            return client;
        }

        node.login = async function (force = false, statusLabel = "Logging in") {
            if (node.loggingIn) return;
            if (node.loggedIn && !force) return;

            if (node.debugEnabled) node.debug("login() called — force: " + force + ", statusLabel: " + statusLabel);

            node.loggingIn = true;

            // notify listeners that login is starting
            try {
                node.emit && node.emit('status', {
                    fill: "yellow",
                    shape: "ring",
                    text: statusLabel,
                });
            } catch (e) {
                node.warn("Failed to emit login-start status: " + e.message);
            }

            try {
                node.jar = new CookieJar();
                node.client = createClient();

                const params = new URLSearchParams();
                params.append("pin", node.pin);
                params.append("submit", "");

                // Send login request but do not follow redirects so we can inspect the initial response (e.g. 301)
                const res = await node.client.post("/login", params.toString(), {
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    maxRedirects: 0,
                    validateStatus: function (status) {
                        // treat 3xx (like 301) as resolved so we can handle it explicitly
                        return status >= 200 && status < 400;
                    }
                });

                // Ensure server returned a 301 redirect. This commonly indicates a successful login.
                if (res.status === 200) {
                    throw new Error("Login failed: Check PIN is correct or too many login attempts");
                } else if (res.status !== 301) {
                    throw new Error("Login failed: Unknown error (Status Code: " + res.status + ")");
                }

                // If server provided Set-Cookie headers on the 301 response, add them to our jar
                const setCookie = res.headers && res.headers['set-cookie'];
                if (setCookie && setCookie.length) {
                    for (const cookieString of setCookie) {
                        try {
                            await node.jar.setCookie(cookieString, `${node.protocol}://${node.host}:${node.port}`);
                        } catch (e) {
                            node.warn("Failed to set cookie from login response: " + e.message);
                        }
                    }
                } else {
                    if (node.debugEnabled) node.debug("No set-cookie headers present on 301 login response");
                }


                node.loggedIn = true;
                node.lastLogin = Date.now();
                node.log("Hailo Libero login successful");

                node.status({
                    fill: "green",
                    shape: "ring",
                    text: "Hailo Libero login successful",
                });

                // notify listeners (e.g. command nodes) about successful login/status
                try {
                    node.emit && node.emit('status', {
                        fill: "green",
                        shape: "ring",
                        text: "Hailo Libero login successful",
                    });
                } catch (e) {
                    node.warn("Failed to emit login-success status: " + e.message);
                }

                // debug cookies
                const cookies = await node.jar.getCookies(`${node.protocol}://${node.host}:${node.port}`);
                if (node.debugEnabled) {
                    node.debug("Hailo Libero cookies after login: " + JSON.stringify(cookies));
                }
            } catch (err) {
                node.loggedIn = false;
                node.error("Hailo Libero login failed", err);

                // notify listeners about failed login/status
                try {
                    node.emit && node.emit('status', {
                        fill: "red",
                        shape: "ring",
                        text: "Hailo Libero login failed: " + (err && err.message ? err.message : String(err)),
                    });
                } catch (e) {
                    node.warn("Failed to emit login-failed status: " + e.message);
                }

                throw err;
            } finally {
                node.loggingIn = false;
            }
        };

        node.on("close", () => {
            if (node.loginTimer) {
                clearInterval(node.loginTimer);
                node.loginTimer = null;
            }
        });

        if (node.keepLoggedIn) {
            node.log("keepLoggedIn enabled: initial login on flow start, session refresh every 60s");

            setImmediate(() => {
                if (node.debugEnabled) node.debug("keepLoggedIn: triggering initial login");
                node.login().catch(() => { });
            });

            node.loginTimer = setInterval(() => {
                node.log("keepLoggedIn: refreshing session (scheduled)");
                if (node.debugEnabled) node.debug("keepLoggedIn: refresh interval fired at " + new Date().toISOString());
                node.login(true, "Refreshing session").catch(() => { });
            }, 60 * 1000);
        }
    }

    RED.nodes.registerType("hailo-libero-device", HailoLiberoDeviceNode, {
        credentials: {
            pin: { type: "password" }
        }
    });

    function attachDebug(client, node) {
        client.interceptors.request.use(req => {

            node.debug("➡️ HTTP REQUEST");
            node.debug("Method: " + req.method.toUpperCase() + " URL: " + req.baseURL + req.url);
            node.debug("Headers: " + JSON.stringify(req.headers));
            node.debug("Data: " + JSON.stringify(req.data));

            return req;
        });

        client.interceptors.response.use(
            res => {

                node.debug("⬅️ HTTP RESPONSE");
                node.debug("Status: " + res.status);
                node.debug("Headers: " + JSON.stringify(res.headers));
                node.debug("Data: " + JSON.stringify(res.data));

                return res;
            },
            err => {
                node.error("⬅️ HTTP ERROR");
                node.error("Message: " + err.message);
                node.error("Code: " + err.code);
                node.error("Status: " + err.response?.status);
                node.error("Data: " + JSON.stringify(err.response?.data));
                return Promise.reject(err);
            }
        );
    }

};
