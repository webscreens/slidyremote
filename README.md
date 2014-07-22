# HTML Slidy remote demo

This repository contains the source code of a **proof of concept** demo for the [Presentation API](http://webscreens.github.io/presentation-api/) which is being developed by the [Second Screen Presentation Community Group](http://www.w3.org/community/webscreens/) in W3C.

The demo lets you project a slide show made with HTML Slidy onto a second screen, and control it through a remote displayed on the first screen.

Demo and details available at [http://tidoust.github.io/slidyremote/](http://tidoust.github.io/slidyremote/).

The repository contains a generic JavaScript shim for the Presentation API that supports casting content to Google Cast devices and attached second screens (under certain conditions), falling back to opening the content on a separate browser window. The shim could be re-used in other demos.
