from __future__ import annotations

import os
import sys
from pathlib import Path

# Testy zmieniają sesje i konta wprost w bazie – pamięć sesji API (security.py) jest w nich wyłączona;
# jej działanie sprawdza test_session_cache.py, włączając ją u siebie
os.environ.setdefault("NETPULSE_SESSION_CACHE_S", "0")

FIXTURES = Path(__file__).parent / "fixtures"
sys.path.insert(0, str(Path(__file__).parent.parent))
