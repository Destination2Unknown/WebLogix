var connectButton = document.getElementById('connectButton');
var startButton = document.getElementById('startButton');
var stopButton = document.getElementById('stopButton');
var resetButton = document.getElementById('resetButton');
var ipAddress = document.getElementById('ipAddress');
var plcSlot = document.getElementById('plcSlot');
var statusBar = document.getElementById('statusBar');
var addTagButton = document.getElementById('addTagButton');
var removeTagButton = document.getElementById('removeTagButton');
var socket = io();
var radios = document.querySelectorAll('input[name=updateRate]');
var tableBody = document.getElementById('tagTableBody');
var tagNames = [];
var tagValues = [];
var tagDataType = [];
var rows = tableBody.querySelectorAll('tr');
var selectedRadio = document.querySelector('input[name="updateRate"]:checked').value;
var tagNameInputs = document.querySelectorAll('input[name="tagName"]');
var lastDataTimestamp = Date.now();
var timerID = null;
const shortTimeOut = 5000;
const mediumTimeOut = 10000;
const longTimeOut = 60000;

function watchDogTimer() {
    if (timerID === null) {
        lastDataTimestamp = Date.now();
        timerID = setInterval(() => {
            let currentTimestamp = Date.now();
            let dataAge = currentTimestamp - lastDataTimestamp;
            if (dataAge > mediumTimeOut) {
                statusBar.textContent = "Stale Data: Reset Connection";
                statusBar.style.display = "block";
                socket.emit('stop_loop');
                stopButton.disabled = true;
                clearInterval(timerID);
                timerID = null;
            }
        }, 1000); // Check every 1 second
    }
}

connectButton.addEventListener('click', () => {
    connectButton.style.cursor = "wait";
    statusBar.textContent = "";
    socket.connect();
    socket.timeout(longTimeOut).emit("connect_to_PLC", { Ip: ipAddress.value, Slot: plcSlot.value }, (err) => {
        if (err) {
            statusBar.textContent = "Connection to Flask Server Timed out";
            statusBar.style.display = "block";
            connectButton.style.cursor = "pointer";
        }
    });
});

socket.on('connect_response', (response) => {
    connectButton.style.cursor = "pointer";
    if (response.Custom_Status === "Success") {
        connectButton.disabled = true;
        startButton.disabled = false;
        resetButton.disabled = false;
        ipAddress.disabled = true;
        plcSlot.disabled = true;
        statusBar.textContent = "";
        statusBar.style.display = "none";
        // Add tag list to options
        let baseTagList = document.getElementById('baseTagList');
        baseTagList.innerHTML = '';
        response.BaseTagList.forEach((item) => {
            let option = document.createElement('option');
            option.value = item;
            baseTagList.appendChild(option);
        });
    }
    else {
        statusBar.textContent = response.Message;
        statusBar.style.display = "block";
    }
});

startButton.addEventListener('click', () => {
    statusBar.textContent = "";
    statusBar.style.display = "none";
    selectedRadio = document.querySelector('input[name="updateRate"]:checked').value;
    // Get a List of Tag names
    tagNames = [];
    rows = tableBody.querySelectorAll('tr');
    rows.forEach((row) => {
        let tagNameInput = row.querySelector('input[name="tagName"]');
        if (tagNameInput && tagNameInput.value.trim() !== '') {
            tagNames.push(tagNameInput.value.trim());
        }
    });
    // Check if there are any tags present
    if (tagNames.length === 0) {
        statusBar.textContent = "Empty Tag List";
        statusBar.style.display = "block";
        // Remove any empty rows
        for (let i = rows.length - 1; i > 0; i--) {
            tableBody.removeChild(rows[i]);
        }
        // Clear the first row
        rows[0].querySelectorAll('input').forEach((input) => {
            input.value = '';
        });
    }
    else {
        // Clean up any empty tag names
        rows.forEach((row) => {
            let tagNameInput = row.querySelector('input[name="tagName"]');
            if (tagNameInput && tagNameInput.value.trim() === '') {
                tableBody.removeChild(row);
            }
        });
        // First Data Request
        startButton.style.cursor = "wait";
        socket.timeout(shortTimeOut).emit("first_read", { RefreshRate: selectedRadio, TagList: tagNames }, (err) => {
            if (err) {
                statusBar.textContent = "Connection to Flask Server Timed out";
                statusBar.style.display = "block";
                startButton.style.cursor = "pointer";
            }
        });
    }
});

socket.on('first_read_response', (response) => {
    startButton.style.cursor = "pointer";
    if (response.Custom_Status === "Success") {
        startButton.disabled = true;
        stopButton.disabled = false;
        addTagButton.disabled = true;
        removeTagButton.disabled = true;
        // Disable buttons
        radios.forEach((input) => {
            input.disabled = true;
        });
        tagNameInputs = document.querySelectorAll('input[name="tagName"]');
        tagNameInputs.forEach((input) => {
            input.disabled = true;
        });
        // Update table
        rows = tableBody.querySelectorAll('tr');
        tagValues = [];
        tagDataType = [];
        rows.forEach((row, index) => {
            tagValues.push(row.querySelector('input[name="tagValue"]'));
            tagValues[index].value = response.Values[index];
            tagDataType.push(row.querySelector('input[name="tagDataType"]'));
            tagDataType[index].value = response.DataTypes[index];
        });
        // If first read was successful, start loop
        socket.emit('start_loop');
        watchDogTimer();
        statusBar.textContent = "";
        statusBar.style.display = "none";
    }
    else {
        // Show error if the response was unsuccessful
        statusBar.textContent = response.Message;
        statusBar.style.display = "block";
    }
});

socket.on('tagData', (response) => {
    if (response.Custom_Status === "Success") {
        lastDataTimestamp = Date.now();
        let i = 0;
        for (let value of response.Values) {
            tagValues[i++].value = value;
        }
    }
    else if (statusBar.textContent === "") {
        statusBar.textContent = response.Message;
        statusBar.style.display = "block";
    }
});

stopButton.addEventListener('click', () => {
    // Stop Timeout watchdog
    clearInterval(timerID);
    timerID = null;
    // Request stop    
    socket.emit('stop_loop');
    statusBar.textContent = "";
    statusBar.style.display = "none";
    startButton.disabled = false;
    stopButton.disabled = true;
    addTagButton.disabled = false;
    removeTagButton.disabled = false;
    // Re-Enable inputs
    tagNameInputs = document.querySelectorAll('input[name="tagName"]');
    tagNameInputs.forEach((input) => {
        input.disabled = false;
    });
    radios.forEach((input) => {
        input.disabled = false;
    });
});

resetButton.addEventListener('click', () => {
    startButton.disabled = true;
    stopButton.disabled = true;
    connectButton.disabled = false;
    resetButton.disabled = true;
    ipAddress.disabled = false;
    plcSlot.disabled = false;
    addTagButton.disabled = false;
    removeTagButton.disabled = true;
    // Re-Enable inputs
    tagNameInputs = document.querySelectorAll('input[name="tagName"]');
    tagNameInputs.forEach((input) => {
        input.disabled = false;
    });
    radios.forEach((input) => {
        input.disabled = false;
    });
    rows = tableBody.querySelectorAll('tr');
    if (rows.length > 1) {
        removeTagButton.disabled = false;
    }
    statusBar.textContent = "";
    statusBar.style.display = "none";
    // Stop Timeout watchdog
    clearInterval(timerID);
    timerID = null;
    // Request stop    
    socket.emit('stop_loop');
    socket.disconnect();
});

addTagButton.addEventListener('click', () => {
    let newRow = document.createElement('tr');
    newRow.innerHTML = `
    <td><input type="text" class="form-control" name="tagName" list="baseTagList"></td>
    <td><input type="text" class="form-control" name="tagValue" readonly disabled></td>
    <td><input type="text" class="form-control" name="tagDataType" readonly disabled></td>
  `;
    tableBody.appendChild(newRow);
    rows = tableBody.querySelectorAll('tr');
    if (rows.length > 1) {
        removeTagButton.disabled = false;
    }
});

removeTagButton.addEventListener('click', () => {
    rows = tableBody.querySelectorAll('tr');
    if (rows.length > 1) {
        tableBody.removeChild(rows[rows.length - 1]);
    }
    if (rows.length <= 2) {
        removeTagButton.disabled = true;
    }
});

addEventListener("unload", () => {
    socket.emit('disconnect');
    socket.disconnect();
});
