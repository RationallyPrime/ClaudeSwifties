"""Collector exception types."""


class CollectorError(RuntimeError):
    """An expected, safely reportable collector failure."""


class ConfigError(CollectorError):
    """The private profile configuration is invalid."""


class ProviderError(CollectorError):
    """A provider-owned local interface failed."""


class AuthenticationRequired(ProviderError):
    """The provider reports that this profile must authenticate again."""


class SpoolFull(CollectorError):
    """The spool cannot accept a unique observation without data loss."""


class TransportError(CollectorError):
    """An observation was not durably acknowledged by the aggregator."""


class AlreadyRunning(CollectorError):
    """Another supervisor owns the profile lock."""
