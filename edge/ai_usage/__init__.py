"""AI Usage schema-3 edge collector.

The package deliberately depends only on Python's standard library.  Provider
credentials stay in provider-owned processes; this package receives quota
metadata through their supported local interfaces and sends only pseudonymous
observations to the configured aggregator.
"""

__version__ = "3.0.0"
