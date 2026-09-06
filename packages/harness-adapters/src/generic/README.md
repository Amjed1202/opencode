# Generic runtime adapters — not implemented

Future explicit API and local/self-hosted routes may reuse OpenCode LLM/provider transports behind this boundary. Each configured runtime declares its actual models, endpoint, auth/billing semantics and capabilities. HTTP-compatible inference alone does not provide tools, terminal, Git, sessions or permissions.

TODO: implement endpoint/auth preflight, stream schemas, cancellation and observed usage; admit any function execution through a separately enforced executor. Keep Anthropic/OpenAI APIs, Gemini/OpenRouter, Ollama/vLLM and custom/internal services as explicit configurations, not automatic subscription fallbacks. Native external coding agents should implement their own adapter instead of being flattened into this HTTP contract.

No generic runtime is registered yet.
