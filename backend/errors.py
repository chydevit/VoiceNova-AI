class AppError(Exception):
    """An error with a message a user can act on. `hint` says what to do next."""

    def __init__(self, message: str, hint: str = "", status: int = 400, detail: str = ""):
        super().__init__(message)
        self.message = message
        self.hint = hint
        self.status = status
        self.detail = detail

    def to_dict(self) -> dict:
        out = {"message": self.message}
        if self.hint:
            out["hint"] = self.hint
        if self.detail:
            out["detail"] = self.detail[-1500:]
        return out


class LineError(AppError):
    """A voice engine couldn't speak one particular line. The other lines still get voiced."""
