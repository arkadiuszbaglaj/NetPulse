from .config import Settings
from .server import serve

if __name__ == "__main__":
    serve(Settings.from_env())
