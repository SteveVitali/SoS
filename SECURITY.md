# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Son of Steve, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email **security@sonofsteve.dev** (or open a [private security advisory](https://github.com/your-org/son-of-steve/security/advisories/new) on GitHub).

Include:
- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix or mitigation**: Dependent on severity, but we aim for 30 days for critical issues

## Security Considerations

Son of Steve executes CLI commands (Claude Code, git, gh) on the host machine. Operators should be aware of the following:

- **Worker processes run with the permissions of the host user.** Do not run workers as root.
- **`SOS_INTERNAL_API_TOKEN`** is a shared secret between the server and workers. Treat it like a password.
- **Slack tokens** (`SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`) should be stored securely and never committed to version control.
- **MongoDB credentials** should use authentication and, for Atlas, IP allowlisting.
- **Web UI basic auth** (`WEB_BASIC_AUTH_USER` / `WEB_BASIC_AUTH_PASS`) is optional but recommended if the server is exposed beyond localhost.
- The `.env` file is gitignored by default — keep it that way.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | ✅ Current |
