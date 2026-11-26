from __future__ import annotations

import os
import sys

from .server import run_server


def main() -> None:
    if "--self-test" in sys.argv:
        print("scribe-locald ok")
        return
    port = int(os.environ.get("SCRIBE_PORT", "47921"))
    run_server(port=port)


if __name__ == "__main__":
    main()
