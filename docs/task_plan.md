# Image channel scheduling
Goal: use gpt-image-2.6-sunburst for 2K/4K and schedule frames across two local API credentials.
1. Inspect provider selection, worker lifecycle, partial recovery. Complete.
2. Implement configurable channels and work-conserving frame workers. Complete.
3. Verify concurrency, failed channel isolation, partial resume, cancellation, model choice. Complete. 43 passed, 1 sample-data test skipped.
4. Configure credentials locally, deploy during idle period, run actual two-channel batch and 4K selection check. Complete.
