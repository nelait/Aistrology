export const MAX_DATASET_BYTES = 1024 ** 3;
/** Same guidance as the backend's DatasetTooLarge error (ING-005). */
export const TOO_LARGE_MESSAGE =
  "dataset exceeds the 1 GB limit. Split the file, drop unused columns, or convert it to Parquet (usually 3-10x smaller than CSV).";
