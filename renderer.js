// =====================================
// AUTO TRACKING MODE (NO UI)
// =====================================
// =====================================
// AUTO TRACKING MODE (CLEAN + LOGGING)
// =====================================

let locationInterval = null;
let heartbeatInterval = null;

document.body.style.margin = "0";
document.body.style.background = "#0f172a";
document.body.style.display = "flex";
document.body.style.justifyContent = "center";
document.body.style.alignItems = "center";
document.body.style.height = "100vh";
document.body.style.fontFamily = "Arial, sans-serif";
document.body.style.color = "white";

document.body.innerHTML = `
    <div style="
        background:#1e293b;
        padding:35px;
        border-radius:14px;
        width:360px;
        box-shadow:0 15px 35px rgba(0,0,0,0.45);
        text-align:center;
    ">
        <h2>🚀 GeoSentinel Service Running</h2>
        <p id="status">Initializing...</p>
        <p style="font-size:12px;color:#94a3b8;">
            Location monitoring active.
        </p>
    </div>
`;

const status = document.getElementById("status");

// =====================================
// AUTO START
// =====================================
window.addEventListener("DOMContentLoaded", async () => {

    try {

        console.log("🔧 App Starting...");

        status.innerText = "Loading configuration...";

        const stationId = await window.api.getStationId();

        if (!stationId) {
            status.innerText = "❌ Station ID not configured";
            status.style.color = "red";
            console.log("❌ No stationId found in config");
            return;
        }

        console.log("📌 Station ID:", stationId);

        status.innerText = "Authenticating...";

        const loginSuccess = await window.api.autoLogin(stationId);

        if (!loginSuccess) {
            status.innerText = "❌ Authentication failed";
            status.style.color = "red";
            console.log("❌ Login failed");
            return;
        }

        console.log("✅ Login successful");

        status.innerText = "✅ Tracking Started";
        status.style.color = "#22c55e";

        startTracking();

    } catch (err) {
        console.error("🔥 Initialization Error:", err);
        status.innerText = "❌ Initialization failed";
        status.style.color = "red";
    }
});

// =====================================
// TRACKING SYSTEM (FINAL STABLE)
// =====================================
function startTracking() {

    if (locationInterval || heartbeatInterval) return;

    let lastKnownLocation = null;

    console.log("🚀 Tracking loop started");

    // =================================
    // LOCATION LOOP (Every 15 sec)
    // =================================
    locationInterval = setInterval(() => {

        navigator.geolocation.getCurrentPosition(

            async (position) => {

                lastKnownLocation = {
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude
                };

                console.log("📍 Fresh location captured:",
                    lastKnownLocation.latitude,
                    lastKnownLocation.longitude
                );

                try {

                    console.log("📦 Saving location locally...");
                    await window.api.sendLocation(
                        lastKnownLocation.latitude,
                        lastKnownLocation.longitude
                    );

                    console.log("🚀 Sent to main process (local save + sync attempt)");

                } catch (err) {
                    console.error("❌ Send location error:", err.message);
                }
            },

            async (err) => {

                console.log("⚠ Location fetch failed:", err.message);

                if (lastKnownLocation) {

                    console.log("🔁 Using last known location");

                    try {
                        await window.api.sendLocation(
                            lastKnownLocation.latitude,
                            lastKnownLocation.longitude
                        );

                        console.log("📦 Last known location stored locally");

                    } catch (err) {
                        console.error("❌ Fallback error:", err.message);
                    }

                } else {
                    console.log("⏳ No location available yet");
                }
            },

            {
                enableHighAccuracy: false,  // IMPORTANT for macOS
                timeout: 15000,
                maximumAge: 60000
            }
        );

    }, 15000);


    // =================================
    // HEARTBEAT LOOP (Every 60 sec)
    // =================================
    heartbeatInterval = setInterval(async () => {

        try {
            console.log("💓 Sending heartbeat...");
            await window.api.sendHeartbeat();
            console.log("💓 Heartbeat success");
        } catch (err) {
            console.error("❌ Heartbeat error:", err.message);
        }

    }, 60000);
}


