module.exports = function (RED) {
    function HailoLiberoCommandNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Command list
        const commands = {
            "push": {
                url: "/push",
                method: "GET"
            },
            "settings": {
                url: "/settings",
                method: "POST"
            },
            "restart": {
                url: "/restart",
                method: "GET"
            }
        };

        node.device = RED.nodes.getNode(config.device);

        // Forward device status events (login/start/failure) to this command node's status
        let _deviceStatusHandler = null;
        if (node.device && node.device.on) {
            _deviceStatusHandler = (s) => {
                try {
                    node.status(s);
                } catch (e) {
                    node.warn('Failed to forward device status: ' + e.message);
                }
            };
            node.device.on('status', _deviceStatusHandler);
        }

        node.on("input", async function (msg, send, done) {
            try {
                await node.device.login();

                // check if msg.cmd is in commands
                const cmdKey = typeof msg.cmd === 'string' ? msg.cmd.trim().toLowerCase() : undefined;
                const cmdConfig = cmdKey ? commands[cmdKey] : undefined;
                if(cmdKey && !cmdConfig) {
                    throw new Error(`Unknown command: ${msg.cmd}`);
                }
                let url = cmdConfig ? cmdConfig.url : msg.url;
                const method = cmdConfig ? cmdConfig.method : msg.method;

                // check data
                let data = null;
                if (msg.payload) {
                    if (typeof msg.payload === "object") {
                        const params = new URLSearchParams();
                        Object.keys(msg.payload).forEach((key) => {
                            const val = msg.payload[key];
                            if (Array.isArray(val)) {
                                val.forEach(v => params.append(key, String(v)));
                            } else if (val !== undefined && val !== null) {
                                params.append(key, String(val));
                            } else {
                                params.append(key, "");
                            }
                        });
                        data = params;
                    } else {
                        data = msg.payload;
                    }
                }

                
                const response = await node.device.client({
                    method,
                    url,
                    data
                });

                // check if response is 200 and data = "OK". If not, try relogin once
                if (response.status !== 200 || (typeof response.data === 'string' && response.data.trim().toUpperCase() !== 'OK')) {
                    node.device.loggedIn = false;
                    await node.device.login(true); // force relogin

                    // retry the command once
                    const retryResponse = await node.device.client({
                        method,
                        url,
                        data
                    });

                    if (retryResponse.status !== 200 || (typeof retryResponse.data === 'string' && retryResponse.data.trim().toUpperCase() !== 'OK')) {
                        throw new Error(`Command "${cmdKey}" failed after relogin: ${retryResponse.status} - ${retryResponse.data}`);
                    } else {
                        msg.payload = retryResponse.data;
                    }
                } else {
                    msg.payload = response.data;

                    
                }

                node.status({
                    fill: "green",
                    shape: "ring",
                    text: `Command "${cmdKey}" successful`,
                });
                
                send(msg);
                done();
                
            } catch (err) {
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: `Command "${cmdKey}" failed: ${err.message}`,
                });
                done(err);
            }
        });

        node.on('close', () => {
            if (node.device && _deviceStatusHandler && node.device.removeListener) {
                node.device.removeListener('status', _deviceStatusHandler);
            }
        });
    }

    RED.nodes.registerType("hailo-libero-command", HailoLiberoCommandNode);
};
