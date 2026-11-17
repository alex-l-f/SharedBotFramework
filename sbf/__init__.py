"""
SharedBotFramework (sbf): assemble multi-agent systems on Google's ADK.

Definitions (agents, systems, prompt fragments, memory schemas) live as YAML
files in the workspace directory; runtime data (chat sessions, outputs,
traces, memory) lives in SQLite under the data directory. ``sbf.app`` is the
FastAPI server; ``sbf.runtime`` compiles a system definition into ADK agents
and runs chat turns on them.
"""

__version__ = "0.1.0"
