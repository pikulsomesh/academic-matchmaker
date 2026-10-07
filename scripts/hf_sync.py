#!/usr/bin/env python3
"""Mirror public/data to and from a Hugging Face dataset repo, which hosts the data for the site.

  pull  replace public/data with the dataset's files (a no-op while the dataset is empty or missing;
        prints empty=true to $GITHUB_OUTPUT then, so the workflow publishes the current data)
  push  upload public/data as one commit, delete dataset files the build no longer writes, then squash
        the dataset's history so daily rebuilds don't pile up old copies

Needs HF_DATASET_REPO ("user/name") and, for push or a private dataset, HF_TOKEN with write access.
The site reads https://huggingface.co/datasets/<repo>/resolve/main/<path> (VITE_DATA_URL in deploy.yml).
"""

import argparse
import os
import shutil
import sys

# Standard library + huggingface_hub only: this also runs before the pipeline's dependencies are installed.
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "data")

README = """---
pretty_name: Academic Matchmaker data
---
# Academic Matchmaker data

Data files behind https://github.com/pikulsomesh/academic-matchmaker, rebuilt by its GitHub Actions
pipeline from [OpenAlex](https://openalex.org). Layout and formats: scripts/README.md in that repo.
This dataset is overwritten on every build; don't edit it by hand.
"""


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def output(name, value):
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(f"{name}={value}\n")


def has_data(api, repo):
    from huggingface_hub.utils import RepositoryNotFoundError

    try:
        files = api.list_repo_files(repo, repo_type="dataset")
    except RepositoryNotFoundError:
        return False
    return "universities.json" in files


def pull(api, repo, data_dir):
    from huggingface_hub import snapshot_download

    if not has_data(api, repo):
        log(f"{repo} has no data yet; keeping {data_dir} as checked out.")
        output("empty", "true")
        return False
    # Start clean so files the last build deleted don't come back from the git checkout.
    shutil.rmtree(data_dir, ignore_errors=True)
    snapshot_download(repo, repo_type="dataset", local_dir=data_dir, token=api.token,
                      allow_patterns=["*.json"])
    shutil.rmtree(os.path.join(data_dir, ".cache"), ignore_errors=True)  # huggingface_hub bookkeeping
    log(f"Pulled {repo} into {data_dir}.")
    output("empty", "false")
    return True


def push(api, repo, data_dir, message):
    api.create_repo(repo, repo_type="dataset", exist_ok=True)
    api.upload_file(path_or_fileobj=README.encode(), path_in_repo="README.md", repo_id=repo, repo_type="dataset",
                    commit_message="Describe the dataset")
    api.upload_folder(folder_path=data_dir, repo_id=repo, repo_type="dataset", commit_message=message,
                      allow_patterns=["*.json"], ignore_patterns=[".cache/*", "*.tmp"],
                      delete_patterns=["*.json"])  # mirror: dataset files this build didn't write are removed
    try:
        api.super_squash_history(repo, repo_type="dataset", commit_message=message)
    except Exception as err:  # history growth is a cost, not a failure
        log(f"Couldn't squash {repo} history: {err}")
    log(f"Pushed {data_dir} to https://huggingface.co/datasets/{repo}.")


def main(argv=None):
    from huggingface_hub import HfApi

    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("action", choices=["pull", "push"])
    p.add_argument("--repo", default=os.environ.get("HF_DATASET_REPO"))
    p.add_argument("--data-dir", default=DATA_DIR)
    p.add_argument("--message", default="Update data")
    args = p.parse_args(argv)
    if not args.repo:
        raise SystemExit("Set HF_DATASET_REPO (e.g. pikulsomesh/academic-matchmaker-data).")
    api = HfApi(token=os.environ.get("HF_TOKEN") or None)
    if args.action == "pull":
        pull(api, args.repo, args.data_dir)
    else:
        push(api, args.repo, args.data_dir, args.message)


if __name__ == "__main__":
    main()
