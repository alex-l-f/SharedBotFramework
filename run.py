"""Start the SharedBotFramework server: ``python run.py [--port 5600] [--reload]``."""

import argparse
import logging
from pathlib import Path

import uvicorn

SBF_DIR = str(Path(__file__).resolve().parent / "sbf")


def main():
    parser = argparse.ArgumentParser(description="SharedBotFramework server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5600)
    parser.add_argument("--reload", action="store_true", help="Restart on code changes (dev)")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # Open SSE streams would otherwise hold a reload (or Ctrl+C) until they
    # end; turns survive in the session store, clients can re-attach.
    uvicorn.run("sbf.app:app", host=args.host, port=args.port, reload=args.reload,
                reload_dirs=[SBF_DIR] if args.reload else None, timeout_graceful_shutdown=3)


if __name__ == "__main__":
    main()
