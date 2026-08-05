# Blog posts

A written introduction to `webai-at-home`, from the idea to the architecture to the interface to the open question about browser tab throttling.

1. [Inference Without Permission](post_1_inference_without_permission.blog_post.md) — why running a language model should not require anyone's approval, and the smallest demonstration that two browser tabs can cooperate on one task.
2. [Designing for Workers That Disappear](post_2_designing_for_workers_that_disappear.blog_post.md) — the architecture that follows from assuming every worker can vanish at any moment: leases, retries, stage placement, and pipelines as data.
3. [Change One Line](post_3_change_one_line.blog_post.md) — the OpenAI-compatible server, what it reconciles between an always-available interface and a cluster of volunteers, and the questions that are still open.
4. [The Tab Nobody Is Watching](post_4_the_tab_nobody_is_watching.blog_post.md) — the throttling experiments in `packages/_idle_experiments`: a hidden tab generates 2.7 times slower with no mitigation, and a quiet, near-inaudible tone recovers full speed.

Each post is a `.blog_post.md` file in this folder, with its cover image in [`images/`](images).
