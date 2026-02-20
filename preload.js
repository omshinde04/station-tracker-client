const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {

    getStationId: () =>
        ipcRenderer.invoke("getStationId"),

    autoLogin: (stationId) =>
        ipcRenderer.invoke("autoLogin", stationId),

    sendLocation: (lat, lng) =>
        ipcRenderer.invoke("sendLocation", { lat, lng }),

    sendHeartbeat: () =>
        ipcRenderer.invoke("sendHeartbeat")
});
