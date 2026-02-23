const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const Database = require("better-sqlite3");

// ================= SINGLE INSTANCE =================
if (!app.requestSingleInstanceLock()) {
    app.quit();
    process.exit(0);
}

let mainWindow;
let authToken = null;
let db;
let configPath;
let dbPath;
let syncInterval = null;

const API =
    require("./package.json").API_URL ||
    "https://backend-1-opx1.onrender.com";

axios.defaults.timeout = 15000;

// ================= SAFE STORAGE PATH =================
const safeUserPath = path.join(app.getPath("appData"), "GeoSentinelService");
app.setPath("userData", safeUserPath);

if (!fs.existsSync(safeUserPath)) {
    fs.mkdirSync(safeUserPath, { recursive: true });
}

// ================= GET STATION ID =================
function getStationId() {
    if (!fs.existsSync(configPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(configPath)).stationId;
    } catch {
        return null;
    }
}

// ================= CLIENT LOGGER =================
async function sendLog(level, message) {
    try {
        const stationId = getStationId() || "UNKNOWN";

        await axios.post(`${API}/api/client-log`, {
            stationId,
            level,
            message
        });
    } catch {
        // never crash service due to logging failure
    }
}

// ================= CREATE HIDDEN WINDOW =================
function createWindow() {
    mainWindow = new BrowserWindow({
        show: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile("index.html");

    session.defaultSession.setPermissionRequestHandler(
        (_, permission, callback) => {
            callback(permission === "geolocation");
        }
    );
}

app.on("window-all-closed", (e) => e.preventDefault());

// ================= HANDLE STATION ARGUMENT =================
function handleStationArgument() {
    const arg = process.argv.find(a => a.startsWith("--station="));
    if (!arg) return;

    const stationId = arg.split("=")[1];
    if (!stationId) return;

    if (!fs.existsSync(configPath)) {
        fs.writeFileSync(
            configPath,
            JSON.stringify({ stationId }, null, 2)
        );
        console.log("Station config created:", stationId);
    }
}

// ================= AUTO LOGIN =================
async function loginIfNeeded() {
    if (authToken) return true;

    const stationId = getStationId();
    if (!stationId) {
        await sendLog("error", "No stationId found in config");
        return false;
    }

    try {
        const res = await axios.post(
            `${API}/api/auth/auto-login`,
            { stationId }
        );

        authToken = res.data.token;
        await sendLog("info", "Auto login successful");
        return true;

    } catch (err) {
        await sendLog("error", "Auto login failed: " + err.message);
        return false;
    }
}

// ================= SAFE SYNC WORKER =================
function startSyncWorker() {

    if (syncInterval) return;

    syncInterval = setInterval(async () => {

        try {

            const loggedIn = await loginIfNeeded();
            if (!loggedIn) return;

            const rows = db.prepare(
                "SELECT * FROM locations LIMIT 20"
            ).all();

            if (rows.length === 0) return;

            await axios.post(
                `${API}/api/location/batch`,
                { records: rows },
                { headers: { Authorization: authToken } }
            );

            const tx = db.transaction(() => {
                rows.forEach(r => {
                    db.prepare(
                        "DELETE FROM locations WHERE id = ?"
                    ).run(r.id);
                });
            });

            tx();

            await sendLog("info", `Batch synced: ${rows.length} records`);

        } catch (err) {

            await sendLog("error", "Sync error: " + err.message);
            authToken = null;
        }

    }, 10000);
}

// ================= IPC =================

// FIXED: getStationId handler (prevents your error)
ipcMain.handle("getStationId", async () => {
    return getStationId();
});

ipcMain.handle("sendLocation", async (_, { lat, lng }) => {

    if (!db) return;

    db.prepare(`
        INSERT INTO locations (latitude, longitude, timestamp)
        VALUES (?, ?, ?)
    `).run(lat, lng, Date.now());

});

ipcMain.handle("sendHeartbeat", async () => {

    try {

        const loggedIn = await loginIfNeeded();
        if (!loggedIn) return;

        await axios.post(
            `${API}/api/heartbeat`,
            {},
            { headers: { Authorization: authToken } }
        );

        await sendLog("info", "Heartbeat sent");

    } catch (err) {

        await sendLog("error", "Heartbeat failed: " + err.message);
        authToken = null;
    }
});

// ================= APP READY =================
app.whenReady().then(async () => {

    configPath = path.join(safeUserPath, "config.json");
    dbPath = path.join(safeUserPath, "local.db");

    db = new Database(dbPath);

    db.prepare(`
        CREATE TABLE IF NOT EXISTS locations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            timestamp INTEGER NOT NULL
        )
    `).run();

    handleStationArgument();
    createWindow();
    startSyncWorker();

    await sendLog("info", "GeoSentinel Service Started");

    console.log("GeoSentinel Service Started");
});