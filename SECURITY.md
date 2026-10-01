# Security policy

Core/mail is a same-OS-user local transport, not remote multi-tenant authorization. Modules and registry files are trusted code/configuration. Labels and `source` are declared origins, not authenticated human identities. Receiving mail cannot grant authority for protected actions.

Keep secrets, Sharing Links, tokens, binding files, native transcripts and databases out of GitHub. Restrict token/configuration files to their owner; do not expose IDE bridges/debug ports beyond loopback. Consumer/provider acknowledgements do not prove business completion. Do not automatically replay an unknown external action.

Report vulnerabilities through the repository's private **Report a vulnerability** feature when available. Otherwise request a private contact in an issue without exploit payloads or secrets. Public issues should contain sanitized reproductions only.

If a credential was exposed, revoke/rotate it at its provider; deleting a file does not remove its Git history.
