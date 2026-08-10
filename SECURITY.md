# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| Latest release on main | ✅ |
| Older releases | ❌ |

## Reporting a Vulnerability

If you discover a security vulnerability in Sky Code, please report it
privately rather than opening a public GitHub issue.

**How to report:**
- Open a [GitHub Security Advisory](https://github.com/quecat01/SkyCode/security/advisories/new)
  on this repository, or
- Email the maintainers at security @ cpnet.ca

Please include:
- A description of the vulnerability
- Steps to reproduce it
- The potential impact
- Any suggested fix if you have one

We will acknowledge your report within 5 business days and aim to provide
a fix or mitigation within 30 days depending on severity.

## Security Considerations

Sky Code executes shell commands and reads/writes files on the machine where
it runs. Review the permission modes documented in the README and use the
mode appropriate for your environment.

Sky Code sends conversation content (including any file contents or command
output included in the chat) to the AI provider configured in your
LITELLM_API_URL. Review your AI provider's data handling policies before
processing sensitive information.
