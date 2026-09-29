# Classification probe window for B02-T08

The Go classification processor now bounds one leased job to five minutes:
inference stops thirty seconds before its final completion deadline. The
Worker's previous half-open probe expired after exactly five minutes from
claim. A slow claim response or completion request could therefore let a
second process acquire the probe while the first still held a usable job
context.

The probe expiry is now six minutes after the Worker claim. The existing
classification test checks the stored expiry exceeds five minutes, that only
one concurrent probe is claimed, and that the owning completion closes the
gate. The abandoned-probe test still forces expiry and verifies that a late
completion cannot close a replacement probe.

This local timing adjustment has no migration. It makes no paid model call and
does not itself complete the production latency, crash or rolling-version
matrix in the Go B02-T08 and B10 issues.
