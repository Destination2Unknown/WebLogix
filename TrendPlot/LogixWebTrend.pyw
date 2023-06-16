from threading import Event, Lock
from flask import Flask, render_template, request
from flask_socketio import SocketIO
from pycomm3 import LogixDriver
import os
import sys
from engineio.async_drivers import gevent
import time

flaskServerIPAddress = "0.0.0.0"
flaskServerPort = 5000
# Change the path to the static and template folder if this is running as an executable
if getattr(sys, "frozen", False):
    template_folder = os.path.join(sys._MEIPASS, "templates")
    static_folder = os.path.join(sys._MEIPASS, "static")
    app = Flask(__name__, template_folder=template_folder, static_folder=static_folder)
else:
    app = Flask(__name__)
app.config["SECRET_KEY"] = "just-any-secret-key"
socketio = SocketIO(app)
clientCommObjects = {}


def explode_struct(struct):
    """
    Extracts all tags from a structure
    """
    exploded_tags = []
    for attr in struct["attributes"]:
        exploded_tags.append(attr)
        if struct["internal_tags"][attr]["tag_type"] == "struct":
            exploded_tags.extend(f"{attr}.{x}" for x in explode_struct(struct["internal_tags"][attr]["data_type"]))
    return exploded_tags


def get_all_tags(tags):
    """
    Takes in a list of Tags in dictionary format and returns a list of all tags
    """
    full_list_of_tags = []
    for tag, tag_data in tags.items():
        full_list_of_tags.append(tag)
        if tag_data["tag_type"] == "struct":
            full_list_of_tags.extend(f"{tag}.{attr}" for attr in explode_struct(tag_data["data_type"]))
    return full_list_of_tags


class PLCDataComms(object):
    def __init__(self):
        self.thread = None
        self.thread_lock = Lock()
        self.stopThread = Event()
        self.custom_status = "Ready"
        self.message = ""
        self.fullBaseTagList = []
        self.data = {"Values": [], "DataTypes": [], "ErrorCodes": []}
        self.rate = 1
        self.tagList = []

    def connect_to_PLC(self, ip, slot="0"):
        """
        Connect to PLC and get the tag list
        """
        try:
            self.comm = LogixDriver(ip + "/" + slot)
            self.comm.open()
            self.comm._sock.sock.settimeout(4)
            self.fullBaseTagList = get_all_tags(self.comm.tags)
        except Exception as e:
            self.custom_status = "Error"
            self.message = str(e)
        else:
            self.custom_status = "Success"
        finally:
            self.fullResponse = {"Custom_Status": self.custom_status, "Message": self.message, "BaseTagList": self.fullBaseTagList}

    def get_PLC_data(self, tagList, rate):
        """
        Setup the timeout, read the tags once and get the data type
        """
        try:
            self.tagList = tagList
            self.rate = float(rate)
            retData = self.comm.read(*self.tagList)
            ret = retData if isinstance(retData, list) else [retData]
            self.data = {"Values": [x.error if x.value is None else x.value for x in ret], "DataTypes": [x.type for x in ret], "ErrorCodes": [x.error for x in ret]}
            self.comm._sock.sock.settimeout(float(rate) + 0.1)
        except Exception as e:
            self.custom_status = "Error"
            self.message = str(e)
        else:
            self.custom_status = "Success"
        finally:
            self.fullResponse = {"Custom_Status": clientCommObjects[request.sid].custom_status, "Message": clientCommObjects[request.sid].message}
            self.fullResponse.update(self.data)

    def loop_read(self, sid):
        """
        Read the taglist from the PLC and send data to javascript, sleep as required
        """
        while not self.stopThread.is_set():
            try:
                ret = self.comm.read(*self.tagList)
                ret = ret if isinstance(ret, list) else [ret]  # Ensure ret is a list

                # Process tag data, rounding if it is a float
                tagData = [x._replace(value=str(round(x.value, 4))) if isinstance(x.value, float) else x for x in ret]

                # Extract values, data types, and error codes from tag data
                tagValues = [x.error if x.value is None else x.value for x in tagData]
                dataTypes = [x.type for x in tagData]
                errorCodes = [x.error for x in tagData]
                timestamp = int(time.time() * 1000)
                # Create a dictionary with the processed data
                self.data = {"Custom_Status": "Success", "Values": tagValues, "DataTypes": dataTypes, "ErrorCodes": errorCodes, "TimeStamp": timestamp}
                socketio.emit("tagData", self.data, room=sid)
            except Exception as e:
                self.message = str(e)
                socketio.emit("tagData", {"Custom_Status": "Error", "Message": self.message}, room=sid)
            finally:
                socketio.sleep(self.rate)


@app.route("/")
def index():
    return render_template("index.html")


@socketio.on("connect_to_PLC")
def on_connect(data):
    """
    Handle connection request between PLC and Client.
    Create an unique object for each client connection.
    """
    clientCommObjects[request.sid] = PLCDataComms()
    clientCommObjects[request.sid].connect_to_PLC(data["Ip"], data["Slot"])
    socketio.emit("connect_response", clientCommObjects[request.sid].fullResponse, room=request.sid)


@socketio.on("first_read")
def first_read(data):
    """
    Handle the first read request between PLC and Client.
    On a successful response the client will issue a start_loop request.
    """
    if request.sid in clientCommObjects:
        clientCommObjects[request.sid].get_PLC_data(data["TagList"], data["RefreshRate"])
        socketio.emit("first_read_response", clientCommObjects[request.sid].fullResponse, room=request.sid)
    else:
        fullResponse = {"Custom_Status": "Error", "Message": "Inactive client, reset connection"}
        socketio.emit("first_read_response", fullResponse, room=request.sid)


@socketio.on("start_loop")
def start_loop():
    """
    This starts the loop if the first_read was successful
    """
    if request.sid in clientCommObjects:
        with clientCommObjects[request.sid].thread_lock:
            if clientCommObjects[request.sid].thread is None:
                clientCommObjects[request.sid].stopThread.clear()
                clientCommObjects[request.sid].thread = socketio.start_background_task(clientCommObjects[request.sid].loop_read, request.sid)
    else:
        fullResponse = {"Custom_Status": "Error", "Message": "Inactive client, reset connection"}
        socketio.emit("start_loop", fullResponse, room=request.sid)


@socketio.on("stop_loop")
def stop_loop():
    """
    Shuts down the loop.
    """
    if request.sid in clientCommObjects:
        clientCommObjects[request.sid].stopThread.set()
        clientCommObjects[request.sid].thread = None


@socketio.on("disconnect")
def disconnect_on_close():
    """
    Handles the client disconnect.
    """
    try:
        if request.sid in clientCommObjects:
            clientCommObjects[request.sid].stopThread.set()
            clientCommObjects[request.sid].thread = None
            if clientCommObjects[request.sid].comm.connected:
                clientCommObjects[request.sid].comm.close()
            clientCommObjects.pop(request.sid)
    except:
        pass


if __name__ == "__main__":
    socketio.run(app, host=flaskServerIPAddress, port=flaskServerPort)
