// ==UserScript==
// @name         FR24 Feeder - Dashboard & Live Photos (v5.2 Fix)
// @namespace    http://tampermonkey.net/
// @version      5.2
// @description  Fixes text contrast issues on white backgrounds and the time header.
// @author       Gemini
// @match        set to your URL for FR24 Feeder page usually port 8754
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // CONFIGURATION (ALWAYS MANUAL)
    // ==========================================
    const myLat = 0;
    const myLon = -0;

    // ==========================================
    // GLOBALS & STORAGE
    // ==========================================
    unsafeWindow.selectedHex = null;
    unsafeWindow.last_data_cache = null;
    unsafeWindow.photoCache = {}; // Caches images so we don't spam the API

    const CONVERSIONS = {
        'nm': { mult: 1, label: 'nm' },
        'mi': { mult: 1.15078, label: 'mi' },
        'km': { mult: 1.852, label: 'km' }
    };

    let savedSortPref = localStorage.getItem('fr24_sort_pref') !== 'false';
    let savedUnitPref = localStorage.getItem('fr24_unit_pref') || 'nm';

    // ==========================================
    // MATH & HELPER FUNCTIONS
    // ==========================================
    function deg2rad(deg) { return deg * (Math.PI / 180); }

    function getDistance(lat1, lon1, lat2, lon2) {
        const R = 3440.065;
        const dLat = deg2rad(lat2 - lat1);
        const dLon = deg2rad(lon2 - lon1);
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
                  Math.sin(dLon/2) * Math.sin(dLon/2);
        return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
    }

    function getBearing(lat1, lon1, lat2, lon2) {
        const dLon = deg2rad(lon2 - lon1);
        const y = Math.sin(dLon) * Math.cos(deg2rad(lat2));
        const x = Math.cos(deg2rad(lat1)) * Math.sin(deg2rad(lat2)) -
                  Math.sin(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.cos(dLon);
        let brng = Math.atan2(y, x) * (180 / Math.PI);
        return (brng + 360) % 360;
    }

    function getDirectionString(bearing) {
        const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
        return dirs[Math.round(bearing / 22.5) % 16];
    }

    // ==========================================
    // UI & CSS INJECTION (Contrast Fixed!)
    // ==========================================
    const customCSS = '<style>' +
        '@keyframes pulseRed { 0% { background-color: #ffcccc; } 50% { background-color: #ff4444; color: white; } 100% { background-color: #ffcccc; } }' +
        'body { font-family: sans-serif; background: #f4f7f6; margin: 20px; color: #333; }' +
        /* ADDED: Forced the header and the time text to be dark navy */
        'h2, #time { color: #2c3e50 !important; }' +
        '.stats-banner { background: #2c3e50; color: white; padding: 12px; border-radius: 5px; display: flex; gap: 20px; margin-bottom: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }' +
        '.stats-banner div { flex: 1; text-align: center; font-size: 14px; }' +
        '.stats-banner strong { font-size: 18px; display: block; color: #f1c40f; }' +
        '#mainContainer { display: flex; gap: 20px; align-items: flex-start; margin-top: 15px; }' +
        '#tracked { flex: 1; white-space: normal !important; background: transparent; border: none; padding: 0; }' +
        '.aircraft-row { color: #333 !important; cursor: pointer; border: 1px solid #ddd; margin-bottom: 8px; padding: 12px; border-radius: 5px; background: white; transition: all 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }' +
        '.aircraft-row:hover { background: #f0f8ff; border-color: #b0d4ff; transform: translateY(-1px); }' +
        '.aircraft-row.selected-row { background: #e6f2ff; border-color: #007bff; border-left: 5px solid #007bff; box-shadow: 0 2px 8px rgba(0,123,255,0.2); }' +
        '.emergency-row { animation: pulseRed 1.5s infinite; border-left: 5px solid red; }' +
        '.detail-panel { width: 320px; background: #1a252f; color: white; padding: 20px; border-radius: 8px; position: sticky; top: 20px; box-shadow: 0 4px 10px rgba(0,0,0,0.2); }' +
        '.detail-panel h3 { margin-top: 0; color: #3498db; border-bottom: 1px solid #34495e; padding-bottom: 10px; display: flex; justify-content: space-between; align-items: center;}' +
        '.detail-panel .live-dot { height: 10px; width: 10px; background-color: #2ecc71; border-radius: 50%; display: inline-block; animation: blink 1s infinite; }' +
        '.detail-item { margin-bottom: 10px; display: flex; justify-content: space-between; border-bottom: 1px dashed #2c3e50; padding-bottom: 4px; font-size: 14px;}' +
        '.detail-label { color: #95a5a6; }' +
        '.detail-val { font-weight: bold; text-align: right; }' +
        '@keyframes blink { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }' +
        '#liveSearch { padding: 6px; width: 250px; border-radius: 4px; border: 1px solid #ccc; margin-left: 15px; color: #333; }' +
        '</style>';

    // ==========================================
    // PHOTO FETCHING LOGIC (Planespotters API)
    // ==========================================
    function fetchAircraftPhoto(hex) {
        if (typeof unsafeWindow.$ === 'undefined') return;
        const $ = unsafeWindow.$;
        const container = $('#photoContainer');
        const imgElem = $('#acImage');
        const linkElem = $('#photoLink');
        const metaElem = $('#acPhotoMeta');

        // Check Cache First
        if (unsafeWindow.photoCache[hex]) {
            if (unsafeWindow.photoCache[hex] === 'none') {
                container.hide();
            } else {
                imgElem.attr('src', unsafeWindow.photoCache[hex].src);
                linkElem.attr('href', unsafeWindow.photoCache[hex].link);
                metaElem.html(unsafeWindow.photoCache[hex].meta);
                container.show();
            }
            return;
        }

        // Setup Loading State
        container.show();
        imgElem.attr('src', '');
        linkElem.attr('href', '#');
        metaElem.html('<i>Searching database...</i>');
        unsafeWindow.photoCache[hex] = 'loading';

        // Fetch from API
        fetch('https://api.planespotters.net/pub/photos/hex/' + hex)
            .then(response => response.json())
            .then(data => {
                if (data && data.photos && data.photos.length > 0) {
                    const photo = data.photos[0];
                    const src = photo.thumbnail_large.src;
                    const link = photo.link;
                    const regText = photo.registration ? `Reg: <b>${photo.registration}</b> | ` : '';
                    const meta = `${regText}Photo by <a href="${link}" target="_blank" style="color:#3498db;">${photo.photographer}</a>`;

                    unsafeWindow.photoCache[hex] = { src: src, link: link, meta: meta };

                    // Only update DOM if they haven't clicked a different plane already
                    if (unsafeWindow.selectedHex === hex) {
                        imgElem.attr('src', src);
                        linkElem.attr('href', link);
                        metaElem.html(meta);
                        container.show();
                    }
                } else {
                    unsafeWindow.photoCache[hex] = 'none';
                    if (unsafeWindow.selectedHex === hex) container.hide();
                }
            })
            .catch(err => {
                unsafeWindow.photoCache[hex] = 'none';
                if (unsafeWindow.selectedHex === hex) container.hide();
            });
    }

    // ==========================================
    // DETAIL PANEL RENDERER (Telemetry Only)
    // ==========================================
    function updateDetailPanel() {
        if (typeof unsafeWindow.$ === 'undefined') return;
        const $ = unsafeWindow.$;
        const panel = $('#telemetryContainer');

        if (!unsafeWindow.selectedHex || !unsafeWindow.last_data_cache || !unsafeWindow.last_data_cache[unsafeWindow.selectedHex]) {
            if (unsafeWindow.selectedHex) {
                panel.html('<p style="color:#e74c3c;">Target lost from radar...</p>');
            } else {
                panel.html('<p style="color:#7f8c8d; font-style: italic;">Select an aircraft from the list on the left to view live telemetry.</p>');
            }
            $('#photoContainer').hide();
            return;
        }

        const ac = unsafeWindow.last_data_cache[unsafeWindow.selectedHex];
        const selectedUnit = $('#unitSelect').val();
        const conversion = CONVERSIONS[selectedUnit];

        const hex = ac[0] || "Unknown";
        const lat = ac[1];
        const lon = ac[2];
        const heading = ac[3] ? ac[3] + "°" : "N/A";
        const alt = ac[4] ? ac[4].toLocaleString() + " ft" : "Ground";
        const speedKts = ac[5] || 0;
        const squawk = ac[6] || "N/A";
        const receiver = ac[7] || "Unknown";
        const lastSeen = new Date(ac[10] * 1000).toLocaleTimeString();
        const onGround = ac[14] == 1 ? '<span style="color:#e74c3c">Yes</span>' : '<span style="color:#2ecc71">No (Airborne)</span>';
        const vSpeed = ac[15] || 0;
        const callsign = ac[16] || "Unknown";

        let distStr = "N/A";
        let bearingStr = "N/A";
        if (lat && lon && Math.abs(lat) > 0.001) {
            let distNM = getDistance(myLat, myLon, lat, lon);
            distStr = (distNM * conversion.mult).toFixed(2) + " " + conversion.label;

            let brng = getBearing(myLat, myLon, lat, lon);
            bearingStr = Math.round(brng) + '° ' + getDirectionString(brng);
        }

        const speedMph = Math.round(speedKts * 1.15078);
        const speedKmh = Math.round(speedKts * 1.852);
        const vIndicator = vSpeed > 100 ? '⬆️ +' : (vSpeed < -100 ? '⬇️ ' : '➡️ ');

        const html = '' +
            '<div class="detail-item"><span class="detail-label">Callsign</span><span class="detail-val" style="color:#f1c40f; font-size:1.2em;">' + callsign + '</span></div>' +
            '<div class="detail-item"><span class="detail-label">ICAO Hex</span><span class="detail-val">' + hex.toUpperCase() + '</span></div>' +
            '<div class="detail-item"><span class="detail-label">Squawk</span><span class="detail-val">' + squawk + '</span></div><br/>' +
            '<div class="detail-item"><span class="detail-label">Altitude</span><span class="detail-val">' + alt + '</span></div>' +
            '<div class="detail-item"><span class="detail-label">Vertical Speed</span><span class="detail-val">' + vIndicator + vSpeed + ' fpm</span></div>' +
            '<div class="detail-item"><span class="detail-label">On Ground</span><span class="detail-val">' + onGround + '</span></div><br/>' +
            '<div class="detail-item"><span class="detail-label">Ground Speed</span><span class="detail-val">' + speedKts + ' kts<br><span style="font-size:0.8em; font-weight:normal; color:#bdc3c7;">(' + speedMph + ' mph / ' + speedKmh + ' km/h)</span></span></div>' +
            '<div class="detail-item"><span class="detail-label">Track/Heading</span><span class="detail-val">' + heading + '</span></div><br/>' +
            '<div class="detail-item"><span class="detail-label">Distance to you</span><span class="detail-val" style="color:#3498db;">' + distStr + '</span></div>' +
            '<div class="detail-item"><span class="detail-label">Look towards</span><span class="detail-val">' + bearingStr + '</span></div>' +
            '<div class="detail-item"><span class="detail-label">Coordinates</span><span class="detail-val" style="font-size:0.85em;">' + lat + ', ' + lon + '</span></div><br/>' +
            '<div class="detail-item"><span class="detail-label">Last Seen</span><span class="detail-val">' + lastSeen + '</span></div>' +
            '<div class="detail-item"><span class="detail-label">Receiver Ant.</span><span class="detail-val">' + receiver + '</span></div>';

        panel.html(html);
    }

    // ==========================================
    // OVERRIDE ORIGINAL PAGE FUNCTION
    // ==========================================
    const initInterval = setInterval(() => {
        if (typeof unsafeWindow.update_aircraft_cb === 'function' && typeof unsafeWindow.$ !== 'undefined') {
            clearInterval(initInterval);

            const $ = unsafeWindow.$;
            $('head').append(customCSS);

            if ($('#mainContainer').length === 0) {
                $('#tracked').wrap('<div id="mainContainer"></div>');

                // Construct the Split Panel UI
                $('#mainContainer').append(
                    '<div class="detail-panel" id="sidePanel">' +
                        '<h3>Radar Details <span class="live-dot" title="Live Link Active"></span></h3>' +
                        '<div id="photoContainer" style="text-align:center; margin-bottom: 15px; display: none; background: #2c3e50; padding: 10px; border-radius: 5px;">' +
                            '<a id="photoLink" href="#" target="_blank"><img id="acImage" style="width:100%; border-radius: 3px; box-shadow: 0 2px 5px rgba(0,0,0,0.5);" src=""></a>' +
                            '<div id="acPhotoMeta" style="color:#bdc3c7; font-size:11px; margin-top:8px;"></div>' +
                        '</div>' +
                        '<div id="telemetryContainer">' +
                            '<p style="color:#7f8c8d; font-style: italic;">Select an aircraft from the list on the left to view live telemetry.</p>' +
                        '</div>' +
                    '</div>'
                );

                const sortChecked = savedSortPref ? 'checked' : '';
                const nmSelected = savedUnitPref === 'nm' ? 'selected' : '';
                const miSelected = savedUnitPref === 'mi' ? 'selected' : '';
                const kmSelected = savedUnitPref === 'km' ? 'selected' : '';

                const controlsHtml = '' +
                    '<div id="customDashboard">' +
                        '<div class="stats-banner" id="statsBanner">' +
                            '<div>Total Tracked <strong id="statTotal">0</strong></div>' +
                            '<div>Closest Aircraft <strong id="statClosest">N/A</strong></div>' +
                            '<div>Highest Altitude <strong id="statAlt">0 ft</strong></div>' +
                        '</div>' +
                        '<div style="display: flex; align-items: center; background: white; color: #333; padding: 10px; border-radius: 5px; border: 1px solid #ddd; margin-bottom: 10px;">' +
                            '<label style="cursor: pointer; margin-right: 20px;">' +
                                '<input type="checkbox" id="sortToggle" ' + sortChecked + '> Sort by closest' +
                            '</label>' +
                            '<label style="cursor: pointer; margin-right: 15px;">' +
                                '<b>Units:</b> ' +
                                '<select id="unitSelect" style="padding: 2px;">' +
                                    '<option value="nm" ' + nmSelected + '>Nautical Miles</option>' +
                                    '<option value="mi" ' + miSelected + '>Statute Miles</option>' +
                                    '<option value="km" ' + kmSelected + '>Kilometers</option>' +
                                '</select>' +
                            '</label>' +
                            '<input type="text" id="liveSearch" placeholder="🔍 Search Callsign, Hex, or Squawk..." />' +
                        '</div>' +
                    '</div>';

                $('#mainContainer').before(controlsHtml);

                // Row Click Event (Triggers Photo Fetch!)
                $('#tracked').on('click', '.aircraft-row', function() {
                    const hex = $(this).data('hex');
                    unsafeWindow.selectedHex = hex;
                    fetchAircraftPhoto(hex); // Fetch image immediately
                    if (unsafeWindow.last_data_cache) unsafeWindow.update_aircraft_cb(unsafeWindow.last_data_cache);
                });

                $('#sortToggle').on('change', function() {
                    localStorage.setItem('fr24_sort_pref', this.checked);
                    if (unsafeWindow.last_data_cache) unsafeWindow.update_aircraft_cb(unsafeWindow.last_data_cache);
                });

                $('#unitSelect').on('change', function() {
                    localStorage.setItem('fr24_unit_pref', this.value);
                    if (unsafeWindow.last_data_cache) unsafeWindow.update_aircraft_cb(unsafeWindow.last_data_cache);
                });

                $('#liveSearch').on('keyup', function() {
                    if (unsafeWindow.last_data_cache) unsafeWindow.update_aircraft_cb(unsafeWindow.last_data_cache);
                });
            }

            // The absolute override
            unsafeWindow.update_aircraft_cb = function(data) {
                unsafeWindow.last_data_cache = data;
                $('#time').html('Updated: ' + new Date().toTimeString() + ' <i>(Processing...)</i>');

                setTimeout(function() {
                    var tt = '';
                    var aircraftList = [];

                    var sortByDistance = $('#sortToggle').is(':checked');
                    var selectedUnit = $('#unitSelect').val();
                    var searchFilter = $('#liveSearch').val().toUpperCase();
                    var conversionFactors = CONVERSIONS[selectedUnit];

                    var total = 0; var maxAlt = 0; var closestCallsign = 'N/A';

                    for(var key in data) {
                        var ac = data[key];
                        var hex = ac[0] || "";
                        var lat = ac[1];
                        var lon = ac[2];
                        var alt = ac[4] || 0;
                        var speed = ac[5] || 0;
                        var squawk = ac[6] || "";
                        var vSpeed = ac[15] || 0;
                        var callsignRaw = ac[16] || "";

                        if (searchFilter && !callsignRaw.includes(searchFilter) && !hex.includes(searchFilter) && !squawk.includes(searchFilter)) {
                            continue;
                        }

                        total++;
                        if (alt > maxAlt) maxAlt = alt;

                        var distanceNM = Infinity;
                        var bearing = 0;
                        var hasValidCoords = (lat != "" && lon != "" && Math.abs(lat) > 0.001 && Math.abs(lon) > 0.001);

                        if(hasValidCoords) {
                            distanceNM = getDistance(myLat, myLon, lat, lon);
                            bearing = getBearing(myLat, myLon, lat, lon);
                        }

                        aircraftList.push({
                            raw: ac, hex: hex, lat: lat, lon: lon, alt: alt, speed: speed, squawk: squawk,
                            vSpeed: vSpeed, callsign: callsignRaw,
                            distanceNM: distanceNM, bearing: bearing, hasValidCoords: hasValidCoords
                        });
                    }

                    if (sortByDistance) {
                        aircraftList.sort(function(a, b) { return a.distanceNM - b.distanceNM; });
                    }

                    if (aircraftList.length > 0 && aircraftList[0].hasValidCoords) {
                        closestCallsign = (aircraftList[0].callsign || "Unknown") + " (" + (aircraftList[0].distanceNM * conversionFactors.mult).toFixed(1) + conversionFactors.label + ")";
                    }

                    for(var i = 0; i < aircraftList.length; i++) {
                        var item = aircraftList[i];

                        var distStr = item.hasValidCoords ? ((item.distanceNM * conversionFactors.mult).toFixed(2) + ' ' + conversionFactors.label) : 'N/A';
                        var bearingStr = item.hasValidCoords ? getDirectionString(item.bearing) : '';

                        var vIndicator = item.vSpeed > 100 ? '⬆️' : (item.vSpeed < -100 ? '⬇️' : '➡️');
                        var isEmergency = ["7700", "7600", "7500"].includes(item.squawk);

                        var classes = ['aircraft-row'];
                        if (isEmergency) classes.push('emergency-row');
                        if (item.hex === unsafeWindow.selectedHex) classes.push('selected-row');

                        var emergencyText = isEmergency ? '<span style="color:red; font-weight:bold; float:right;">🚨 EMERGENCY</span>' : '';

                        tt += '<div class="' + classes.join(' ') + '" data-hex="' + item.hex + '">' +
                            emergencyText +
                            '<strong style="color:#0056b3; font-size:1.1em;">' + (item.callsign || 'Unknown') + '</strong> ' +
                            '<span style="color:#777; font-size:0.9em;">(Hex: ' + item.hex + ')</span><br/>' +
                            'Alt: ' + item.alt + ' ft ' + vIndicator + ' | Speed: ' + item.speed + ' kts | SQW: ' + (item.squawk || 'N/A') + '<br/>' +
                            '<span style="color:#d35400; font-weight:bold;">' + distStr + '</span> ' + (bearingStr ? 'towards the ' + bearingStr : '') +
                        '</div>';
                    }

                    $('#tracked').html(tt || '<div style="padding: 20px; text-align:center; color:#777;">No aircraft found.</div>');
                    $('#time').html('Updated: ' + new Date().toTimeString());

                    $('#statTotal').text(total);
                    $('#statClosest').text(closestCallsign);
                    $('#statAlt').text(maxAlt.toLocaleString() + ' ft');

                    updateDetailPanel(); // Updates telemetry without touching the photo

                    clearTimeout(unsafeWindow.aircraftUpdateTimer);
                    unsafeWindow.aircraftUpdateTimer = setTimeout(unsafeWindow.update_aircraft, 5000);

                }, 0);
            };

            console.log("FR24 Dashboard v5.2: Header contrast fixed!");
        }
    }, 100);
})();
