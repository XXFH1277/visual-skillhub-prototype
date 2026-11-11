Started provider/runner review. No runtime configuration changed yet.
Implemented per-channel frame workers and provider discovery. Scheduling, channel failure plus resume, cancellation, and credential deduplication tests added. One test fixture initially used a product 16:9 aspect, which the product entry does not support. Corrected it to poster 16:9.
Channel failure test used HTTP send arrival order, which varies due to parallel file reads. Replaced the order assertion with per-channel request counts. Frame indexes and reuse hashes remain asserted.
Deployed at original URL during idle state. Both credentials authenticated. Pool reports 2 channels and total concurrency 6. 4K generation and square upscale select gpt-image-2.6-sunburst. Public normal-entry four-frame 2K test submitted as dcb14662-d981-49f7-bf43-8ebdc7a40d60.

Public normal-entry batch completed successfully. Four original 2048x2048 images displayed. Generation stage 91 seconds. Primary frames took 49,51,41 seconds and secondary frame 91 seconds. Effective speedup varies and no 2x claim can be made. Verified both channel IDs in persisted report.
