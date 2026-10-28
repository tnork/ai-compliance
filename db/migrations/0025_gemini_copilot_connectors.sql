-- 0025: enterprise connectors for Gemini (Google Workspace audit) + Copilot
-- (Microsoft 365 / Purview). Adapters in web/lib/connectors/{gemini,copilot}.ts.
--
-- Gemini Workspace audit is USAGE-LEVEL (no prompt/output content, like Grok);
-- Copilot's Graph enterprise-interactions endpoint returns content (source_t =
-- existing 'purview'). Both are built to documented API shapes and are UNPROVEN
-- until run against a live enterprise workspace.

-- new event source for Gemini's Workspace audit ('purview' already exists for
-- Copilot). Enum add-value must be its own statement (cannot be used same tx).
alter type source_t add value if not exists 'gemini_api';

-- widen the provider allowlist on provider_connection (was openai|anthropic|grok)
alter table provider_connection drop constraint if exists provider_connection_provider_check;
alter table provider_connection add constraint provider_connection_provider_check
  check (provider in ('openai', 'anthropic', 'grok', 'gemini', 'copilot'));
