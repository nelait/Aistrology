"""Pluggable email delivery (NTF-002).

* ``smtp``: stdlib ``smtplib`` with mandatory STARTTLS (verified certificate) and optional login. The password
  is the platform secret ``smtp-password``; it never appears in settings, logs or errors.
* ``console``: logs the message envelope (development).
* ``memory``: keeps messages in a list (tests).

Emails are always sent from a job (``notification.email``), so SMTP latency never blocks a request.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass
from email.message import EmailMessage
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState

log = logging.getLogger("app.email")
SMTP_PASSWORD_SECRET = "smtp-password"


@dataclass(frozen=True)
class Attachment:
    filename: str
    content: bytes
    content_type: str = "application/octet-stream"


@dataclass(frozen=True)
class Email:
    to: str
    subject: str
    body: str
    attachments: tuple[Attachment, ...] = ()


class EmailSender(ABC):
    @abstractmethod
    def send(self, email: Email) -> None:
        """Deliver one message; raise on failure so the job is retried."""


class ConsoleSender(EmailSender):
    def send(self, email: Email) -> None:
        log.info("email (console sender) to=%s subject=%s", email.to, email.subject)


class MemorySender(EmailSender):
    def __init__(self) -> None:
        self.outbox: list[Email] = []
        self._lock = threading.Lock()

    def send(self, email: Email) -> None:
        with self._lock:
            self.outbox.append(email)


class SMTPSender(EmailSender):
    def __init__(
        self,
        host: str,
        port: int,
        from_addr: str,
        *,
        username: str | None = None,
        password: str | None = None,
        timeout: float = 20.0,
        smtp_class: type[smtplib.SMTP] = smtplib.SMTP,
    ):
        self.host, self.port, self.from_addr = host, port, from_addr
        self.username, self._password = username, password
        self.timeout = timeout
        self.smtp_class = smtp_class

    def send(self, email: Email) -> None:
        msg = EmailMessage()
        msg["From"], msg["To"], msg["Subject"] = self.from_addr, email.to, email.subject
        msg.set_content(email.body)
        for a in email.attachments:
            maintype, _, subtype = a.content_type.partition("/")
            msg.add_attachment(a.content, maintype=maintype, subtype=subtype or "octet-stream", filename=a.filename)
        with self.smtp_class(self.host, self.port, timeout=self.timeout) as smtp:
            smtp.ehlo()
            smtp.starttls(context=ssl.create_default_context())  # never send credentials or content in clear text
            smtp.ehlo()
            if self.username:
                smtp.login(self.username, self._password or "")
            smtp.send_message(msg)

    def __repr__(self) -> str:  # keep the password out of reprs and logs
        return f"SMTPSender(host={self.host!r}, port={self.port}, username={self.username!r})"


def email_sender(state: AppState) -> EmailSender:
    """The configured sender (tests inject one as ``state.extras['email_sender']``)."""
    sender = state.extras.get("email_sender")
    if sender is not None:
        return sender
    s = state.settings
    if s.email_sender == "smtp":
        if not s.smtp_host:
            raise RuntimeError("AP_EMAIL_SENDER=smtp needs AP_SMTP_HOST")
        sender = SMTPSender(
            s.smtp_host, s.smtp_port, s.smtp_from, username=s.smtp_username, password=state.secrets.get("platform", SMTP_PASSWORD_SECRET)
        )
    elif s.email_sender == "memory":
        sender = MemorySender()
    else:
        sender = ConsoleSender()
    return state.extras.setdefault("email_sender", sender)
