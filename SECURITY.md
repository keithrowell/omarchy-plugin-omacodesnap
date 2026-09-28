# Security Policy

OmaCodeSnap is a local desktop tool: it reads your current selection and the
active Omarchy theme, and writes an image to your clipboard and
`~/Pictures`. It has no network access, no server component, and does not
transmit anything anywhere.

The most plausible security-relevant issues here are things like: a crafted
selection or filename that breaks out of the sandboxed grammar
build/highlight path, a path-handling bug in `bin/install` or `bin/omacodesnap`
that writes outside the intended directories, or a vendored grammar/query
file that was tampered with.

## Reporting a vulnerability

If you find a security issue, please **do not open a public issue**. Email
keith@keithrowell.com with details and, if possible, steps to reproduce.
You should get a response within a few days. Once a fix is ready, it'll be
released and the issue disclosed with credit (unless you'd prefer
otherwise).
