"""
NeMo Guardrails server for ``nemo_guardrails`` classifiers. Runs in its own
virtual environment (services/nemo_guardrails/venv: nemoguardrails's
dependencies would downgrade the main one's); start it with
scripts/run_guardrails.py.

Serves every folder of <workspace>/guardrails (one per classifier, written
by SBF) as a config id, and reloads a config when its files change. The
rails' LLM calls use OPENAI_API_KEY, set here from OPENROUTER_API_KEY in the
project's .env unless already set.
"""

import argparse
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8300)
parser.add_argument("--configs", default=os.getenv("SBF_GUARDRAILS", str(Path(
    os.getenv("SBF_WORKSPACE", ROOT / "workspace")) / "guardrails")))
args = parser.parse_args()

from dotenv import dotenv_values  # noqa: E402

env = dotenv_values(ROOT / ".env")
if not os.getenv("OPENAI_API_KEY") and env.get("OPENROUTER_API_KEY"):
    os.environ["OPENAI_API_KEY"] = env["OPENROUTER_API_KEY"]
Path(args.configs).mkdir(parents=True, exist_ok=True)

import uvicorn  # noqa: E402
from nemoguardrails.server import api  # noqa: E402

api.app.rails_config_path = os.path.abspath(args.configs)
api.app.auto_reload = True
uvicorn.run(api.app, host="127.0.0.1", port=args.port, workers=1)
