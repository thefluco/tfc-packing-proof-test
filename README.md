# TFC Packing Proof - TEST phase

The packing-station photo app, talking to its Google Apps Script backend: photos go to the "Packing Proof"
folder in Google Drive and one row per box to the "Packing Proof" Sheet. Two stages: MEASURE (before booking)
writes "TEST pre-booking", PROOF (after booking) writes "TEST boxes" (TEST mode: everything under the TEST folder).
Nothing works without the station key, which is typed on the phone and never in this code.

Built 20261019-1813 by `tests/make_test_site.py --backend`.
