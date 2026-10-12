#!/bin/bash
# Start the local MongoDB used by openstock-tw (historical bars, trading, auth).
# Data lives in .mongo-data/ (persistent). Run once per VM boot:
#   bash scripts/start-mongo.sh
set -e
MONGOD="$HOME/.cache/mongodb-binaries/dl/mongodb-linux-x86_64-ubuntu2404-8.2.6/bin/mongod"
DBPATH="$HOME/workspace/openstock-tw/.mongo-data"
if (echo > /dev/tcp/127.0.0.1/27017) 2>/dev/null; then
  echo "MongoDB already running on 127.0.0.1:27017"
  exit 0
fi
mkdir -p "$DBPATH"
"$MONGOD" --dbpath "$DBPATH" --bind_ip 127.0.0.1 --port 27017 \
  --fork --logpath "$DBPATH/mongod.log"
echo "MongoDB started. URI: mongodb://127.0.0.1:27017/openstock"
