"""Job handlers for the training module (registered on import)."""

from __future__ import annotations

from ..datasets_io import MultiTableError
from ..jobs.core import JobContext, PermanentJobError, job_handler
from ..storage.datasets import DatasetNotFound
from .preprocessing import PreprocessingConfig  # noqa: F401 - makes joblib-loaded pipelines importable
from .service import NotFound, TrainingService
from .trainer import TrainingError


@job_handler("training.run")
def training_job(ctx: JobContext) -> dict:
    try:
        return TrainingService(ctx.state).run_experiment(
            ctx.tenant_id, ctx.actor, ctx.params["experiment_id"], ctx.job_id, progress=ctx.progress
        )
    except (TrainingError, NotFound, DatasetNotFound, MultiTableError, KeyError) as exc:
        raise PermanentJobError(str(exc)) from exc
