# Image Prompt Recipes

Use the system `imagegen` skill and built-in `image_gen` by default. Generate a separate text-free base for each module.

## Shared Product Lock

Append this block to every prompt:

```text
Input images: treat every supplied product image as an identity and geometry reference.
Product invariants: preserve the exact silhouette, proportions, color, finish, seams, controls, openings, labels, logo position, and visible included parts.
Do not invent unseen sides, hidden features, accessories, packaging, variants, or performance outcomes.
No text, letters, numbers, captions, badges, borders, watermark, UI, fake labels, or certification marks.
Leave deliberate negative space for later deterministic typography.
Commercial product imagery, realistic materials, physically plausible lighting, no visual clutter.
```

If only one view is supplied, keep the generated camera close to that view. Do not rotate far enough to expose unknown surfaces.

## Hero

```text
Use case: ads-marketing
Asset type: e-commerce detail-page hero base
Primary request: present the referenced product as the sole visual hero in a scene derived from its own design language.
Scene/backdrop: <product-specific environment or abstract material field>
Composition/framing: <platform-specific framing>; product occupies <percentage>; negative space on <side>
Lighting/mood: <visual fingerprint>
Color palette: derive from the product and brand palette
Constraints: premium hierarchy, unmistakable product focus, no unsupported feature visualization
```

## Benefit Scene

```text
Use case: ads-marketing
Asset type: benefit module base
Primary request: show the product in a realistic context that communicates <verified benefit> without text.
Scene/backdrop: <credible target-user environment>
Composition/framing: human interaction only when appropriate; product remains clearly visible
Constraints: outcome must be visually plausible and limited to supplied facts
```

## Feature Mechanism

```text
Use case: product-mockup
Asset type: feature explanation base
Primary request: emphasize the visible <part or mechanism> of the referenced product.
Composition/framing: close three-quarter or macro view that does not reveal unknown surfaces
Lighting/mood: directional studio light that separates materials
Constraints: no exploded parts unless the internal construction is supplied; no arrows or labels
```

## Detail Macro

```text
Use case: product-mockup
Asset type: craftsmanship detail base
Primary request: macro photograph of the supplied visible detail: <detail>.
Composition/framing: tight crop with enough recognizable product context
Materials/textures: match the reference exactly; do not upgrade or replace the finish
Constraints: no invented grain, weave, coating, stitching, engraving, or hardware
```

## Lifestyle

```text
Use case: photorealistic-natural
Asset type: product lifestyle module base
Primary request: place the referenced product in <realistic scenario> for <target audience>.
Composition/framing: editorial but credible; product is used correctly and remains identifiable
Lighting/mood: natural environmental light matching the product palette
Constraints: do not show accessories or package contents unless supplied
```

## Steps

Create one visual per step when the action materially differs. Do not ask the model to render text or multi-panel instructions.

```text
Use case: scientific-educational
Asset type: single instruction-step visual base
Primary request: show only this verified action: <action>.
Composition/framing: clear hand placement and product orientation, uncluttered neutral background
Constraints: one action, one product state, no arrows, labels, numbers, or additional steps
```

## Scale and Dimensions

Do not generate measurement markings. The composer adds exact labels.

```text
Use case: product-mockup
Asset type: size context base
Primary request: show the referenced product in a neutral scale context using <verified reference object or human hand>.
Composition/framing: camera and perspective suitable for later dimension lines
Constraints: maintain realistic relative scale from supplied dimensions; omit this module when dimensions are unknown
```

## Closing

```text
Use case: ads-marketing
Asset type: e-commerce closing module base
Primary request: resolve the page with the referenced product in a confident, calm final composition.
Scene/backdrop: simplified version of the hero environment
Composition/framing: generous negative space for a short closing line
Constraints: no promotion badge, price, discount, CTA button, or guarantee unless separately supplied and permitted
```

## Platform Restrictions

- **TikTok Shop:** do not use these generation recipes for upload-ready listing images. Use real user photos and deterministic crops.
- **Etsy:** do not create upload-ready synthetic product renderings. Use original actual-item photos; generated imagery may only be labeled concept/reference.
- **eBay:** prefer actual item photos, especially for used, vintage, collectible, or condition-sensitive products.
