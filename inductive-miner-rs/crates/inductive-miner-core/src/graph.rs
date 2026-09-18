//! Graph utilities over local activity indices.
//!
//! Components are returned in a **deterministic** order: parts sorted by their
//! smallest member, members ascending. ProM returns them in trove hash order,
//! which is arbitrary; for xor and parallel that only decides child order
//! (semantically irrelevant), but it also decides *which part absorbs the
//! leftovers* in the parallel repair, which is not. Picking the lowest index
//! makes that choice reproducible.

/// Union-find with a stable representative: the smallest member wins, so the
/// component ordering does not depend on the order merges happened in.
pub struct Components {
    parent: Vec<usize>,
}

impl Components {
    pub fn new(n: usize) -> Self {
        Components {
            parent: (0..n).collect(),
        }
    }

    pub fn find(&mut self, mut x: usize) -> usize {
        while self.parent[x] != x {
            self.parent[x] = self.parent[self.parent[x]];
            x = self.parent[x];
        }
        x
    }

    pub fn merge(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra == rb {
            return;
        }
        // Smallest index becomes the root, which is what makes the output order
        // independent of merge order.
        if ra < rb {
            self.parent[rb] = ra;
        } else {
            self.parent[ra] = rb;
        }
    }

    pub fn same(&mut self, a: usize, b: usize) -> bool {
        self.find(a) == self.find(b)
    }

    pub fn count(&mut self) -> usize {
        self.parts().len()
    }

    /// Parts, ordered by smallest member; members ascending.
    pub fn parts(&mut self) -> Vec<Vec<usize>> {
        let n = self.parent.len();
        let mut roots: Vec<usize> = Vec::new();
        let mut of: Vec<usize> = vec![0; n];
        for i in 0..n {
            of[i] = self.find(i);
        }
        for i in 0..n {
            if of[i] == i {
                roots.push(i);
            }
        }
        roots.sort_unstable();
        let mut index = vec![usize::MAX; n];
        for (k, &r) in roots.iter().enumerate() {
            index[r] = k;
        }
        let mut parts: Vec<Vec<usize>> = vec![Vec::new(); roots.len()];
        for i in 0..n {
            parts[index[of[i]]].push(i);
        }
        parts
    }
}

/// Connected components of the undirected view of the directly-follows graph.
pub fn connected_components(n: usize, edges: impl Iterator<Item = (usize, usize)>) -> Vec<Vec<usize>> {
    let mut c = Components::new(n);
    for (a, b) in edges {
        c.merge(a, b);
    }
    c.parts()
}

/// Tarjan's strongly connected components, iterative.
///
/// Iterative rather than recursive on purpose: this runs inside a WASM module
/// with a fixed stack, and a 20 000-activity cycle would otherwise be a stack
/// overflow rather than a slow answer. Components come back ordered by their
/// smallest member.
pub fn strongly_connected_components(n: usize, out_adj: &[Vec<usize>]) -> Vec<Vec<usize>> {
    let mut index = vec![usize::MAX; n];
    let mut low = vec![0usize; n];
    let mut on_stack = vec![false; n];
    let mut stack: Vec<usize> = Vec::new();
    let mut next_index = 0usize;
    let mut result: Vec<Vec<usize>> = Vec::new();

    // (node, position in its adjacency list)
    let mut work: Vec<(usize, usize)> = Vec::new();

    for root in 0..n {
        if index[root] != usize::MAX {
            continue;
        }
        work.push((root, 0));
        while let Some(&mut (v, ref mut pi)) = work.last_mut() {
            if *pi == 0 {
                index[v] = next_index;
                low[v] = next_index;
                next_index += 1;
                stack.push(v);
                on_stack[v] = true;
            }

            let mut recursed = false;
            while *pi < out_adj[v].len() {
                let w = out_adj[v][*pi];
                *pi += 1;
                if index[w] == usize::MAX {
                    work.push((w, 0));
                    recursed = true;
                    break;
                } else if on_stack[w] {
                    low[v] = low[v].min(index[w]);
                }
            }
            if recursed {
                continue;
            }

            if low[v] == index[v] {
                let mut component = Vec::new();
                loop {
                    let w = stack.pop().unwrap();
                    on_stack[w] = false;
                    component.push(w);
                    if w == v {
                        break;
                    }
                }
                component.sort_unstable();
                result.push(component);
            }

            work.pop();
            if let Some(&mut (parent, _)) = work.last_mut() {
                low[parent] = low[parent].min(low[v]);
            }
        }
    }

    result.sort_unstable_by_key(|c| c[0]);
    result
}

/// Transitive closure of a DAG, one bitset row per node.
///
/// The closure is unavoidably n² *bits* — the sequence cut asks about every
/// pair — but it does not have to be n² *bytes*, and it does not have to be
/// stored twice. A `Vec<Vec<bool>>` cost 8× the memory and one allocation per
/// row; a backward closure alongside it cost another factor of two, for
/// information already present, since "b reaches a" is just the forward
/// relation read the other way round.
///
/// At 10 000 activities that is the difference between ~460 MB and ~13 MB,
/// which is the difference between a limit imposed by memory and one imposed
/// by time.
pub struct Reachability {
    n: usize,
    words: usize,
    bits: Vec<u64>,
}

impl Reachability {
    pub fn compute(n: usize, out_adj: &[Vec<usize>]) -> Reachability {
        let words = n.div_ceil(64);
        let mut r = Reachability {
            n,
            words,
            bits: vec![0u64; n * words],
        };
        for v in 0..n {
            // Depth-first accumulation; the condensed graph is acyclic by
            // construction, so the visited bits are enough to terminate.
            let mut stack: Vec<usize> = out_adj[v].clone();
            while let Some(w) = stack.pop() {
                if r.reaches(v, w) {
                    continue;
                }
                r.set(v, w);
                stack.extend(out_adj[w].iter().copied());
            }
        }
        r
    }

    #[inline]
    fn set(&mut self, a: usize, b: usize) {
        self.bits[a * self.words + (b >> 6)] |= 1u64 << (b & 63);
    }

    /// Can `a` reach `b`?
    #[inline]
    pub fn reaches(&self, a: usize, b: usize) -> bool {
        self.bits[a * self.words + (b >> 6)] & (1u64 << (b & 63)) != 0
    }

    /// Are the two connected in either direction? Nodes that are not are
    /// alternatives rather than consecutive steps.
    #[inline]
    pub fn related(&self, a: usize, b: usize) -> bool {
        self.reaches(a, b) || self.reaches(b, a)
    }

    pub fn len(&self) -> usize {
        self.n
    }

    pub fn is_empty(&self) -> bool {
        self.n == 0
    }
}
