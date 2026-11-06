# Security policy

Please report suspected security issues privately to the repository maintainers rather than opening a public issue with an exploit. Include the affected version, impact, and a minimal reproduction that does not contain private repository data.

ArchShield treats scanned repositories as untrusted input. It parses source without executing it, does not install target-project dependencies, rejects symbolic links in hosted ZIP archives, enforces archive and file-size limits, and removes its temporary hosted scan workspace after each request.

The local CLI and local browser interface analyze files on the user's machine and do not transmit source code. The hosted Vercel scanner necessarily receives the selected source files to perform analysis. It currently accepts public GitHub repositories and ZIP uploads only; do not submit secrets or code you are not authorized to share. Private-repository authentication is intentionally not supported. Keep ArchShield and its dependencies updated.
