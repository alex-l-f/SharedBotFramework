"""
Run BotBase's embedding service (the phase-1 knowledge backend) from its own
folder — it resolves its index paths relative to the working directory.
Use BotBase's Python environment:

    E:\\Experiments\\BotBase\\venv\\Scripts\\python.exe scripts/run_botbase_embedding.py [--botbase DIR] [--port 8201]
"""

import argparse
import os
import sys

import uvicorn

parser = argparse.ArgumentParser()
parser.add_argument("--botbase", default=r"E:\Experiments\BotBase")
parser.add_argument("--port", type=int, default=8201)
args = parser.parse_args()

os.chdir(args.botbase)
sys.path.insert(0, args.botbase)
uvicorn.run("embedding_service:app", host="127.0.0.1", port=args.port, workers=1)
