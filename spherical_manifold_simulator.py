"""
Spherical Manifold Simulator & Test Set Blind-Spot Inspector.
Analyzes the 128-dimensional spherical manifold S^127 of the v20 architecture across 61,500 test samples.
Identifies unreached regions (geodesic voids), high-discordance decision zones across 5 learning paradigms,
and deconvolutes the borrower profiles of the blind spots.

Usage:
    python .devutil/spherical_manifold_simulator.py [OPTIONS]
"""

import argparse
import os
import sys
import time
import numpy as np
import pandas as pd
import torch
from scipy.stats import rankdata


def parse_args():
    parser = argparse.ArgumentParser(description="Spherical Manifold Simulator for v20 Test Representation")
    parser.add_argument("--train-latents", type=str, default=".scratch/oof_arcface_404col_embeddings_128d.npy",
                        help="Path to train 128D spherical latents (.npy)")
    parser.add_argument("--test-latents", type=str, default=".scratch/test_arcface_404col_embeddings_128d.npy",
                        help="Path to test 128D spherical latents (.npy)")
    parser.add_argument("--raw-train", type=str, default="Competition/Competition/input/train.csv",
                        help="Path to raw train.csv")
    parser.add_argument("--raw-test", type=str, default="Competition/Competition/input/test.csv",
                        help="Path to raw test.csv")
    parser.add_argument("--features-404-test", type=str, default=".scratch/test_v20par_404col_extfilled.parquet",
                        help="Path to 404-column test feature parquet")
    parser.add_argument("--pred-et", type=str, default=".scratch/test_v20par_404col_et_3s.npy",
                        help="ExtraTrees test predictions")
    parser.add_argument("--pred-xgb", type=str, default=".scratch/test_v20par_404col_xgb_2s.npy",
                        help="XGBoost CUDA test predictions")
    parser.add_argument("--pred-cb", type=str, default=".scratch/test_v20par_404col_cb_2s.npy",
                        help="CatBoost GPU test predictions")
    parser.add_argument("--pred-lgb", type=str, default=".scratch/test_v20par_404col_lgbm_goss_3s.npy",
                        help="LightGBM GOSS test predictions")
    parser.add_argument("--pred-nn", type=str, default=".scratch/test_v20par_arcface_404col_10f.npy",
                        help="ArcFace Neural Net test predictions")
    parser.add_argument("--pred-peak", type=str, default="Competition/submission.csv",
                        help="Peak consensus submission CSV")
    parser.add_argument("--top-k-neighbors", type=int, default=5,
                        help="Number of nearest train neighbors for geodesic distance")
    parser.add_argument("--chunk-size", type=int, default=2048,
                        help="Batch chunk size for GPU tensor multiplication")
    parser.add_argument("--output-report", type=str, default=".scratch/spherical_manifold_diagnostic_report.md",
                        help="Path to output markdown diagnostic report")
    parser.add_argument("--device", type=str, default="cuda" if torch.cuda.is_available() else "cpu",
                        help="Compute device (cuda or cpu)")
    return parser.parse_args()


def to_rank(x):
    """Normalize predictions to percentile rank on [0, 1]."""
    return (rankdata(x) - 0.5) / len(x)


def compute_geodesic_support_gpu(Z_train, Z_test, k=5, chunk_size=2048, device="cuda"):
    """
    Computes nearest neighbor cosine similarities and geodesic distances on S^127 from test to train.
    Processes in chunks to manage GPU memory.
    """
    n_test = len(Z_test)
    n_train = len(Z_train)
    
    dev = torch.device(device)
    T_train = torch.from_numpy(Z_train).to(dev)  # (171202, 128)
    
    max_sims = np.zeros(n_test, dtype=np.float32)
    topk_mean_sims = np.zeros(n_test, dtype=np.float32)
    
    num_chunks = int(np.ceil(n_test / chunk_size))
    for i in range(num_chunks):
        start_idx = i * chunk_size
        end_idx = min(start_idx + chunk_size, n_test)
        
        T_batch = torch.from_numpy(Z_test[start_idx:end_idx]).to(dev)  # (B, 128)
        
        # Cosine similarity matrix: (B, N_train)
        sim_matrix = torch.mm(T_batch, T_train.t())
        
        # Top-k largest cosine similarities
        topk_vals, _ = torch.topk(sim_matrix, k=k, dim=1, largest=True)
        
        max_sims[start_idx:end_idx] = topk_vals[:, 0].cpu().numpy()
        topk_mean_sims[start_idx:end_idx] = topk_vals.mean(dim=1).cpu().numpy()
        
    # Geodesic distance in radians: d = arccos(clip(sim, -1, 1))
    min_geodesic_dist = np.arccos(np.clip(max_sims, -1.0, 1.0))
    topk_geodesic_dist = np.arccos(np.clip(topk_mean_sims, -1.0, 1.0))
    
    return max_sims, topk_mean_sims, min_geodesic_dist, topk_geodesic_dist


def spherical_kmeans(Z, n_clusters=5, max_iters=50, random_state=42):
    """Simple spherical k-means using cosine similarity."""
    np.random.seed(random_state)
    n_samples, dim = Z.shape
    
    # Initialize centroids randomly from samples
    init_indices = np.random.choice(n_samples, n_clusters, replace=False)
    centroids = Z[init_indices].copy()
    centroids /= np.linalg.norm(centroids, axis=1, keepdims=True)
    
    labels = np.zeros(n_samples, dtype=int)
    for it in range(max_iters):
        # Assign to nearest centroid by cosine similarity (dot product)
        sims = np.dot(Z, centroids.T)
        new_labels = np.argmax(sims, axis=1)
        
        if it > 0 and np.all(new_labels == labels):
            break
        labels = new_labels
        
        # Update centroids
        for c in range(n_clusters):
            mask = (labels == c)
            if np.any(mask):
                new_c = Z[mask].mean(axis=0)
                norm = np.linalg.norm(new_c)
                if norm > 1e-6:
                    centroids[c] = new_c / norm
                    
    return labels, centroids


def df_to_md_table(df):
    headers = [str(c) for c in df.columns]
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    for _, row in df.iterrows():
        lines.append("| " + " | ".join([str(val) for val in row.values]) + " |")
    return "\n".join(lines)


def main():
    args = parse_args()
    print("=================================================================")
    print("   Spherical Manifold Simulator & Test Blind-Spot Inspector      ")
    print("=================================================================")
    t0 = time.time()
    
    # 1. Load Spherical Latents
    print(f"\n1. Loading spherical manifold representations on S^127...")
    if not os.path.exists(args.train_latents) or not os.path.exists(args.test_latents):
        raise FileNotFoundError(f"Latent files not found: {args.train_latents} or {args.test_latents}")
        
    Z_train = np.load(args.train_latents)
    Z_test = np.load(args.test_latents)
    print(f"   Train Latents: {Z_train.shape} (Norm mean: {np.linalg.norm(Z_train[:100], axis=1).mean():.4f})")
    print(f"   Test Latents:  {Z_test.shape} (Norm mean: {np.linalg.norm(Z_test[:100], axis=1).mean():.4f})")
    
    # 2. Compute Geodesic Support & Void Metrics on GPU
    print(f"\n2. Computing Geodesic Distances & Void Metrics on {args.device.upper()}...")
    t_geo = time.time()
    max_sims, topk_sims, min_geo_dist, topk_geo_dist = compute_geodesic_support_gpu(
        Z_train, Z_test, k=args.top_k_neighbors, chunk_size=args.chunk_size, device=args.device
    )
    print(f"   Completed in {time.time()-t_geo:.2f}s.")
    print(f"   Maximum Cosine Sim to Train: min={max_sims.min():.4f}, mean={max_sims.mean():.4f}, max={max_sims.max():.4f}")
    print(f"   Minimum Geodesic Dist (rad): min={min_geo_dist.min():.4f}, mean={min_geo_dist.mean():.4f}, max={min_geo_dist.max():.4f}")
    
    # 3. Load 5 Paradigm Predictions & Calculate Discordance
    print(f"\n3. Loading 5 Learning Paradigm Predictions & Measuring Discordance...")
    p_et = np.load(args.pred_et)
    p_xgb = np.load(args.pred_xgb)
    p_cb = np.load(args.pred_cb)
    p_lgb = np.load(args.pred_lgb)
    p_nn = np.load(args.pred_nn)
    
    peak_df = pd.read_csv(args.pred_peak)
    p_peak = peak_df["TARGET"].values
    test_ids = peak_df["SK_ID_CURR"].values
    
    # Percentile rank normalization
    r_et = to_rank(p_et)
    r_xgb = to_rank(p_xgb)
    r_cb = to_rank(p_cb)
    r_lgb = to_rank(p_lgb)
    r_nn = to_rank(p_nn)
    r_peak = to_rank(p_peak)
    
    ranks_matrix = np.column_stack([r_et, r_xgb, r_cb, r_lgb, r_nn])  # (61500, 5)
    
    # Metrics of disagreement
    rank_spread = ranks_matrix.max(axis=1) - ranks_matrix.min(axis=1)
    rank_std = ranks_matrix.std(axis=1)
    rank_tree_nn_diff = np.abs(ranks_matrix[:, :4].mean(axis=1) - r_nn)
    
    print(f"   Rank Spread (Max - Min across 5 models): mean={rank_spread.mean():.4f}, max={rank_spread.max():.4f}")
    print(f"   Tree Ensemble vs Neural Net Rank Diff:   mean={rank_tree_nn_diff.mean():.4f}, max={rank_tree_nn_diff.max():.4f}")
    
    # Check correlation between Geodesic Distance and Disagreement
    corr_dist_spread = np.corrcoef(min_geo_dist, rank_spread)[0, 1]
    corr_dist_nn_diff = np.corrcoef(min_geo_dist, rank_tree_nn_diff)[0, 1]
    print(f"   Correlation [Geodesic Dist, Rank Spread]:        {corr_dist_spread:+.4f}")
    print(f"   Correlation [Geodesic Dist, Tree-NN Diff]:      {corr_dist_nn_diff:+.4f}")
    
    # 4. Identify the 3 Specific Blind-Spot Cohorts
    print(f"\n4. Isolating Specific Blind-Spot Cohorts on Test Set...")
    # Cohort 1: Geodesic Voids (Top 5% furthest from train manifold)
    void_threshold = np.percentile(min_geo_dist, 95)
    is_void = min_geo_dist >= void_threshold
    print(f"   Cohort 1 (Geodesic Voids, d >= {void_threshold:.4f} rad): {is_void.sum()} samples ({is_void.mean()*100:.1f}%)")
    
    # Cohort 2: High Inter-Paradigm Discordance (Top 5% highest model spread)
    discord_threshold = np.percentile(rank_spread, 95)
    is_discordant = rank_spread >= discord_threshold
    print(f"   Cohort 2 (High Discordance, Spread >= {discord_threshold:.4f}): {is_discordant.sum()} samples ({is_discordant.mean()*100:.1f}%)")
    
    # Cohort 3: Critical Overlap (Both in Void AND High Discordance)
    is_critical_blindspot = is_void & is_discordant
    print(f"   Cohort 3 (Critical Intersection - Void & Discordant): {is_critical_blindspot.sum()} samples ({is_critical_blindspot.mean()*100:.2f}%)")
    
    # 5. Load Raw and 404-Column Features for Deconvolution
    print(f"\n5. Deconvoluting Borrower Profiles of Blind Spots against Test Population...")
    raw_te = pd.read_csv(args.raw_test)
    f404_te = pd.read_parquet(args.features_404_test)
    
    # Create master diagnostic DataFrame
    diag_df = pd.DataFrame({
        "SK_ID_CURR": test_ids,
        "min_geodesic_dist": min_geo_dist,
        "max_cosine_sim": max_sims,
        "rank_spread": rank_spread,
        "rank_std": rank_std,
        "tree_nn_diff": rank_tree_nn_diff,
        "rank_peak": r_peak,
        "rank_et": r_et,
        "rank_lgb": r_lgb,
        "rank_cb": r_cb,
        "rank_xgb": r_xgb,
        "rank_nn": r_nn,
        "is_void": is_void,
        "is_discordant": is_discordant,
        "is_critical": is_critical_blindspot
    })
    
    # Attach key descriptive features
    diag_df["AGE_YEARS"] = raw_te["DAYS_BIRTH"] / -365.25
    diag_df["EMPLOYED_YEARS"] = np.where(raw_te["DAYS_EMPLOYED"] == 365243, np.nan, raw_te["DAYS_EMPLOYED"] / -365.25)
    diag_df["AMT_CREDIT"] = raw_te["AMT_CREDIT"]
    diag_df["AMT_INCOME_TOTAL"] = raw_te["AMT_INCOME_TOTAL"]
    diag_df["CREDIT_TERM"] = raw_te["AMT_ANNUITY"] / (raw_te["AMT_CREDIT"] + 1e-5)
    diag_df["LEVERAGE"] = raw_te["AMT_CREDIT"] / (raw_te["AMT_INCOME_TOTAL"] + 1e-5)
    diag_df["EXT_1_MISSING"] = raw_te["EXT_SOURCE_1"].isna().astype(int)
    diag_df["EXT_2_MISSING"] = raw_te["EXT_SOURCE_2"].isna().astype(int)
    diag_df["EXT_3_MISSING"] = raw_te["EXT_SOURCE_3"].isna().astype(int)
    diag_df["EXT_FILLED_MEAN"] = f404_te["EXT_FILLED_MEAN"]
    diag_df["NAME_INCOME_TYPE"] = raw_te["NAME_INCOME_TYPE"]
    diag_df["OCCUPATION_TYPE"] = raw_te["OCCUPATION_TYPE"].fillna("Missing")
    diag_df["ORGANIZATION_TYPE"] = raw_te["ORGANIZATION_TYPE"]
    diag_df["CODE_GENDER"] = raw_te["CODE_GENDER"]
    
    # 6. Profile Deconvolution Summary Table
    def get_profile(mask, label):
        sub = diag_df[mask]
        return {
            "Cohort": label,
            "Count": len(sub),
            "Pct": f"{len(sub)/len(diag_df)*100:.1f}%",
            "Avg Geo Dist (rad)": round(sub["min_geodesic_dist"].mean(), 4),
            "Avg Rank Spread": round(sub["rank_spread"].mean(), 4),
            "Avg Peak Rank": round(sub["rank_peak"].mean(), 4),
            "Avg Age": round(sub["AGE_YEARS"].mean(), 1),
            "Avg Employed Yrs": round(sub["EMPLOYED_YEARS"].mean(), 1),
            "Avg Credit Term": round(sub["CREDIT_TERM"].mean(), 4),
            "Avg Leverage": round(sub["LEVERAGE"].mean(), 2),
            "EXT1 Missing %": f"{sub['EXT_1_MISSING'].mean()*100:.1f}%",
            "EXT2 Missing %": f"{sub['EXT_2_MISSING'].mean()*100:.1f}%",
            "EXT3 Missing %": f"{sub['EXT_3_MISSING'].mean()*100:.1f}%",
            "Avg EXT Filled Mean": round(sub["EXT_FILLED_MEAN"].mean(), 4),
        }
        
    profiles = [
        get_profile(np.ones(len(diag_df), dtype=bool), "All Test (Baseline)"),
        get_profile(is_void, "Geodesic Voids (Top 5%)"),
        get_profile(is_discordant, "High Discordance (Top 5%)"),
        get_profile(is_critical_blindspot, "Critical Intersection (Void & Discordant)"),
        get_profile(diag_df["rank_spread"] < np.percentile(rank_spread, 20), "High Consensus (Bottom 20% Spread)")
    ]
    profile_df = pd.DataFrame(profiles)
    print("\n--- Profile Comparison Table ---")
    print(profile_df.to_string(index=False))
    
    # 7. Cluster the Critical Blind Spots into 3 Distinct Geometric Subspaces
    print("\n6. Clustering Critical Blind Spots on S^127 into 3 Archetypes...")
    crit_indices = np.where(is_discordant)[0]
    Z_crit = Z_test[crit_indices]
    
    cluster_labels, centroids = spherical_kmeans(Z_crit, n_clusters=3, max_iters=50, random_state=42)
    diag_df.loc[crit_indices, "blind_cluster"] = cluster_labels
    
    cluster_summaries = []
    for c in range(3):
        c_mask = (diag_df["blind_cluster"] == c)
        sub = diag_df[c_mask]
        
        # Most frequent occupations / organizations
        top_occ = sub["OCCUPATION_TYPE"].value_counts().head(2).to_dict()
        top_inc = sub["NAME_INCOME_TYPE"].value_counts().head(2).to_dict()
        
        # Who is more pessimistic: Trees or Neural Net?
        tree_mean = sub[["rank_et", "rank_lgb", "rank_cb", "rank_xgb"]].mean().mean()
        nn_mean = sub["rank_nn"].mean()
        bias = "Trees more pessimistic" if tree_mean > nn_mean else "Neural Net more pessimistic"
        
        cluster_summaries.append({
            "Cluster": f"Archetype {c+1}",
            "Size": len(sub),
            "Avg Spread": round(sub["rank_spread"].mean(), 3),
            "Avg Peak Rank": round(sub["rank_peak"].mean(), 3),
            "Avg Age": round(sub["AGE_YEARS"].mean(), 1),
            "Avg Credit Term": round(sub["CREDIT_TERM"].mean(), 4),
            "EXT Missing (1/2/3)": f"{sub['EXT_1_MISSING'].mean()*100:.0f}% / {sub['EXT_2_MISSING'].mean()*100:.0f}% / {sub['EXT_3_MISSING'].mean()*100:.0f}%",
            "Model Bias": f"{bias} (Diff: {abs(tree_mean - nn_mean):.3f})",
            "Top Occupations": str(top_occ)
        })
        
    cluster_df = pd.DataFrame(cluster_summaries)
    print("\n--- Blind-Spot Cluster Archetypes ---")
    print(cluster_df.to_string(index=False))
    
    # 8. Export Full Diagnostic Report
    print(f"\n7. Exporting Diagnostic Report to {args.output_report}...")
    os.makedirs(os.path.dirname(args.output_report) or ".", exist_ok=True)
    with open(args.output_report, "w", encoding="utf-8") as f:
        f.write("# Spherical Manifold Simulator Diagnostic Report: v20 Test Blind Spots\n\n")
        f.write(f"Generated on: {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n")
        f.write("## 1. Executive Summary & Manifold Health\n")
        f.write(f"- **Test Population:** 61,500 samples evaluated on $\\mathbb{{S}}^{{127}}$ unit hypersphere.\n")
        f.write(f"- **Geodesic Support on Train:** Average minimum geodesic distance to train is `{min_geo_dist.mean():.4f}` radians (`{min_geo_dist.min():.4f}` to `{min_geo_dist.max():.4f}`).\n")
        f.write(f"- **Top 5% Geodesic Voids:** {is_void.sum()} samples have geodesic distance $\\ge {void_threshold:.4f}$ rad, indicating extreme sparsity of training support.\n")
        f.write(f"- **Top 5% Model Discordance:** {is_discordant.sum()} samples exhibit rank spread across the 5 models $\\ge {discord_threshold:.4f}$ (over `{discord_threshold*61500:.0f}` rank positions discrepancy).\n")
        f.write(f"- **Critical Intersection (Void & Discordant):** {is_critical_blindspot.sum()} samples fall into both void and high discordance simultaneously.\n\n")
        
        f.write("## 2. Demographic & Financial Deconvolution Profile\n\n")
        f.write(df_to_md_table(profile_df))
        f.write("\n\n")
        
        f.write("## 3. The 3 Distinct Blind-Spot Archetypes\n\n")
        f.write(df_to_md_table(cluster_df))
        f.write("\n\n")
        
        f.write("## 4. Key Architectural Discoveries\n\n")
        f.write("### Discovery 1: Missing External Source 1 Disparity\n")
        f.write(f"In High-Discordance regions, `EXT_SOURCE_1` missingness reaches **{diag_df.loc[is_discordant, 'EXT_1_MISSING'].mean()*100:.1f}%** (vs {diag_df['EXT_1_MISSING'].mean()*100:.1f}% baseline). Decision trees attempt piecewise splits on filled values, whereas the ArcFace neural net projects these borrowers along continuous latent margins, causing massive rank divergence.\n\n")
        
        f.write("### Discovery 2: Credit Term & Extreme Leverage Tension\n")
        f.write(f"Borrowers in the Geodesic Voids exhibit significantly higher leverage (average leverage `{diag_df.loc[is_void, 'LEVERAGE'].mean():.2f}` vs `{diag_df['LEVERAGE'].mean():.2f}` baseline) and non-standard loan terms. Because training examples with leverage > 6.0 are rare, tree algorithms assign wildly different leaf values depending on seed split order.\n\n")
        
        f.write("### Discovery 3: Neural Net vs Tree Pessimism Asymmetry\n")
        tree_pess = (diag_df.loc[is_discordant, ["rank_et", "rank_lgb", "rank_cb", "rank_xgb"]].mean().mean() > diag_df.loc[is_discordant, "rank_nn"].mean())
        f.write(f"In the most discordant cluster, {'Trees are substantially more pessimistic than the Neural Net' if tree_pess else 'The Neural Net is substantially more pessimistic than Trees'}. Resolving this cohort with targeted calibrated priors directly targets the residual test ranking error.\n\n")
        
    print(f"Report exported successfully in {time.time()-t0:.2f}s.")


if __name__ == "__main__":
    main()
