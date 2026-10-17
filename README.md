# TFC Packing Proof - TEST site

A test build of the packing-station photo app (v2: MEASURE before booking, PROOF after booking). It runs a
stand-in for its Google backend inside the browser, so photos and Sheet rows stay on the device that took
them. It holds no keys and sends nothing to Google. The supervisor sets a 4-digit PIN the first time the
supervisor menu (the lock icon) opens. A phone that ran a real build on this address keeps that setup and its
waiting uploads aside, untouched; the next real build sends them.

To try PROOF: measure a parcel first, then Supervisor (lock icon) > "TEST: what reached Drive and the Sheet" >
"Book with an AWB" (stands in for the operator pasting the AWB), stick the label next to the slip and take
the first photo again.

The order-number reader (Tesseract.js, Apache-2.0) is in vendor/tesseract/ with its licences.

Built 20261017-2006 by `tests/make_test_site.py`.
