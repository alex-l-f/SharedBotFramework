"""
Run MIRA's SAFER safety classifier service (ModernBERT-large + MIRA's
fine-tuned checkpoint, GPU when available) for ``safer`` classifiers:

    venv\Scripts\python scripts/run_safer.py [--mira E:/MIRA_Staging/ChattyMIRA] [--port 8100]

The checkpoint is MIRA's dist/checkpoint_*.pt; the base model downloads from
Hugging Face on first start. Endpoints: POST /classify/chat {messages,
threshold}, GET /health.
"""

import argparse
import os
import sys

import uvicorn

parser = argparse.ArgumentParser()
parser.add_argument("--mira", default=r"E:\MIRA_Staging\ChattyMIRA")
parser.add_argument("--port", type=int, default=8100)
args = parser.parse_args()

dist = os.path.join(args.mira, "dist")
os.environ.setdefault("SAFER_CHECKPOINT_DIR", dist)
sys.path.insert(0, dist)
uvicorn.run("safer_service:app", host="127.0.0.1", port=args.port, workers=1)
