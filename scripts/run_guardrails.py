"""
Start the NeMo Guardrails server (port 8300) for ``nemo_guardrails``
classifiers, in its own environment; creates that environment first if it
is missing:

    venv\Scripts\python scripts/run_guardrails.py [--port 8300]
"""

import subprocess
import sys
from pathlib import Path

SERVICE = Path(__file__).resolve().parent.parent / "services" / "nemo_guardrails"
PYTHON = SERVICE / "venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")

if not PYTHON.exists():
    subprocess.run([sys.executable, "-m", "venv", str(SERVICE / "venv")], check=True)
    subprocess.run([str(PYTHON), "-m", "pip", "install", "nemoguardrails", "langchain-openai", "python-dotenv", "uvicorn", "fastapi",
                    "watchdog"], check=True)
raise SystemExit(subprocess.call([str(PYTHON), str(SERVICE / "serve.py"), *sys.argv[1:]]))
