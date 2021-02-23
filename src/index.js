const net = require("net");
const https = require("https");
const fs = require("fs");
const { spawn } = require("child_process");
const _ = require("lodash");
const redis = require("redis");
const express = require("express");
const stream = require("stream");
const client = redis.createClient({ host: "redis", port: 6379 });
const cors = require("cors");
client.on("error", function (error) {
  console.error(error);
});
const jingle = fs.readFileSync("./ident.mp3");

function spawnFfmpeg(label = "") {
  let args = [
    "-hide_banner",
    "-re",
    "-i",
    "pipe:0",
    "-f",
    "mp3",
    "-vn",
    "-ar",
    "44100",
    "-b:a",
    "196k",
    "-af",
    "loudnorm=I=-18:LRA=13:TP=-2",
    "pipe:1"
  ];

  const ffmpeg = spawn("ffmpeg", args);

  console.log("Spawning ffmpeg " + args.join(" "), label);
  ffmpeg.stderr.on("data", function (data) {
    console.log(label, "Incoming data: " + data);
  });

  ffmpeg.stderr.on("error", function (error) {
    console.log(label, "Error" + error);
  });
  ffmpeg.on("exit", function (code) {
    console.log("FFMPEG child process exited with code " + code, label);
  });

  return ffmpeg;
}
let scheduledItems = [];
client.keys("freshcaster-schedule-item:*", (err, keys) => {
  keys.map((k) => {
    client.get(k, (err, reply) => {
      scheduledItems.push(JSON.parse(reply));
      scheduledItems = _.sortBy(scheduledItems, "time");
    });
  });
});

const schedulingTick = () => {
  // console.log(scheduledItems);
  if (scheduledItems.length > 0 && scheduledItems[0].time <= Date.now()) {
    console.log(scheduledItems[0]);
    ctrl.schedule(
      scheduledItems[0].type == "live" ? State.LIVE : State.SCHEDULED,
      scheduledItems[0].url
    );
    scheduledItems.shift();
  }
};
setInterval(schedulingTick, 500);

let muxer = new stream.PassThrough();

muxer.pipe(fs.createWriteStream(`./recordings/broadcast-${Date.now()}.mp3`));
const State = {
  LIVE: Symbol("live"),
  OFFAIR: Symbol("offair"),
  SCHEDULED: Symbol("scheduled")
};

const Fanout = (muxer) => {
  let mode = State.OFFAIR;
  let liveSource;
  let currentStream;
  let lastStream;
  const choose = () => {
    console.log("Choosing new Offair track");
    if (mode === State.OFFAIR) {
      fs.readdir("./eighties", (err, files) => {
        if (currentStream) currentStream.kill();
        let file = _.sample(files);
        currentStream = spawnFfmpeg(`Offair: ${file}`);
        fs.createReadStream(`./eighties/${file}`)
          .pipe(currentStream.stdin)
          .on("error", (e) => console.error("FS error"));
        currentStream.stdout.on("data", (d) => {
          muxer.write(d);
        });
        currentStream.stdout.on("end", () => {
          console.log("EOF offair track");
          choose();
        });
        currentStream.stdout.on("error", (e) => {
          console.log("Error offair track", e);
        });
      });
    }
  };
  choose();
  return {
    disconnectLive() {
      if (mode === State.LIVE) {
        mode = State.OFFAIR;
        choose();
      }
    },
    schedule(type, url) {
      if (type === State.LIVE) {
        if (!liveSource) {
          return false;
        }
        mode = State.LIVE;
        lastStream = currentStream;
        currentStream = spawnFfmpeg("Live source");

        liveSource
          .pipe(currentStream.stdin)
          .on("end", () => {
            console.log("Live Stream ended early");
            if (mode === State.LIVE) {
              mode = State.OFFAIR;
              choose();
            }
          })
          .on("error", (e) => {
            console.log("Live Stream errored out", e);
          });
        currentStream.stdout
          .on("data", (d) => {
            if (lastStream && mode === State.LIVE) {
              lastStream.kill();
              lastStream = null;
            }
            muxer.write(d);
          })
          .on("end", () => {
            console.log("Live Stream encoding ended early");
            if (mode === State.LIVE) {
              mode = State.OFFAIR;
              choose();
            }
          })
          .on("error", (e) => {
            console.log("Live Stream encoding errored out", e);
          });
      }
      if (type === State.SCHEDULED) {
        mode = State.SCHEDULED;
        lastStream = currentStream;
        currentStream = spawnFfmpeg(`Scheduled: ${url}`);
        https
          .get(url, (res) => {
            res
              .pipe(currentStream.stdin)
              .on("error", (e) =>
                console.error("Scheduled item download errored out", e)
              )
              .on("end", (e) => console.error("Scheduled item download ended"));
          })
          .on("error", (e) => {
            console.error("Scheduled item download connection errored out", e);
            if (mode === State.SCHEDULED) {
              mode = State.OFFAIR;
              choose();
            }
          })
          .on("end", () =>
            console.log("Scheduled item download connection ended")
          );

        currentStream.stdout.on("data", (d) => {
          if (lastStream && mode === State.SCHEDULED) {
            lastStream.kill();
            lastStream = null;
          }

          muxer.write(d);
        });
        currentStream.stdout.on("end", () => {
          console.log("Scheduled encoding ended early");
          if (mode === State.SCHEDULED) {
            mode = State.OFFAIR;
            choose();
          }
        });
        currentStream.stdout.on("error", (e) => {
          console.log("Scheduled item download errored out", e);
        });
      }
    },
    connectLiveSource(socket) {
      if (mode === State.LIVE) {
        return false;
      }
      if (mode === State.SCHEDULED || mode == State.OFFAIR) {
        if (liveSource) {
          liveSource.end();
        } else {
          liveSource = socket;
          liveSource.pipe(
            fs.createWriteStream(`./recordings/${Date.now()}.mp3`)
          );
        }
      }
    }
  };
};
const ctrl = Fanout(muxer);

const server = net
  .createServer((socket) => {
    socket.once("data", (d) => {
      let head = d.toString();
      const [meta, ...rawHeaders] = head.split("\r\n");
      const [method, url, version] = meta.split(" ");
      if (method == "SOURCE" || method == "PUT") {
        const headers = Object.fromEntries(
          rawHeaders
            .filter((h) => h.length > 0)
            .map((h) => h.split(":"))
            .map(([name, value]) => [name.trim().toLowerCase(), value.trim()])
        );
        const [protocol, auth] = headers.authorization.split(" ");
        const [username, password] = Buffer.from(auth, "base64")
          .toString()
          .split(":");
        if (username !== "source" || password != process.env.STREAM_PW) {
          return socket.end("HTTP/1.1 401 UNAUTHORIZED\r\n\r\n");
        }
        socket.write("HTTP/1.1 200 OK\r\n\r\n");
        if (url == "/live") {
          console.log("Connecting live source", headers);
          ctrl.connectLiveSource(socket);
        } else {
          socket.end();
        }
      } else {
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nConnection: keep-alive\r\n\r\n"
        );
        console.log("Add listener", rawHeaders);
        socket.write(jingle);
        muxer.pipe(socket);
        socket.on("error", () => console.log("Listener error", rawHeaders));
        socket.on("end", () => console.log("Close Listener", rawHeaders));
      }
    });
  })
  .on("error", (err) => {
    console.log("Big ol' error", err);
  });

server.listen(7878, "0.0.0.0", () => {
  console.log("opened server on", server.address());
});

const app = express();
app.use(express.json());
app.use(cors());

app.post(`/schedule`, (req, res) => {
  client.set(
    `freshcaster-schedule-item:${req.body.time}`,
    JSON.stringify(req.body)
  );
  scheduledItems.push(req.body);
  scheduledItems = _.sortBy(scheduledItems, "time");

  res.json(req.body);
});
app.post(`/disconnect`, (req, res) => {
  ctrl.disconnectLive();
  res.status(200).send();
});
console.log("Listening");
app.listen(8989, () => "Server started");
