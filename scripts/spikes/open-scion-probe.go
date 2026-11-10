// A disposable compatibility probe, run with the pinned git-ai checkout's go.mod.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"time"

	auth "github.com/feder-cr/git-ai/auth"
	"github.com/feder-cr/git-ai/client"
	pb "github.com/feder-cr/git-ai/proto/go/gitalypb"
	"github.com/feder-cr/git-ai/sdk"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func check(ok bool, message string) {
	if !ok {
		panic(message)
	}
}

func expect(label string, err error, code codes.Code) {
	fmt.Printf("%s: %v\n", label, err)
	check(status.Code(err) == code, label+": unexpected status")
}

func rawDiff(ctx context.Context, conn *grpc.ClientConn, repo *pb.Repository, base, head string) ([]byte, error) {
	stream, err := pb.NewDiffServiceClient(conn).RawDiff(ctx, &pb.RawDiffRequest{
		Repository: repo, LeftCommitId: base, RightCommitId: head,
	})
	if err != nil {
		return nil, err
	}
	var patch []byte
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			return patch, nil
		}
		if err != nil {
			return nil, err
		}
		patch = append(patch, chunk.GetData()...)
	}
}

func main() {
	check(len(os.Args) == 5, "usage: probe denied|allowed BASE HEAD PATCH_FILE")
	mode, base, head, patchFile := os.Args[1], os.Args[2], os.Args[3], os.Args[4]
	check(mode == "denied" || mode == "allowed", "invalid mode")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	address, token := os.Getenv("GRAFT_ADDRESS"), os.Getenv("GRAFT_TOKEN")
	conn, err := client.DialContext(ctx, address, client.WithGrpcOptions([]grpc.DialOption{
		grpc.WithPerRPCCredentials(auth.RPCCredentialsV2(token)),
	}))
	must(err)
	defer conn.Close()
	repository := &pb.Repository{StorageName: "default", RelativePath: "fixture.git"}
	patch, err := rawDiff(ctx, conn, repository, base, head)
	if mode == "denied" {
		expect("RawDiff with default agent allowlist", err, codes.PermissionDenied)
		return
	}
	must(err)
	must(os.WriteFile(patchFile, patch, 0600))
	fmt.Printf("RawDiff: bytes=%d sha256=%x\n%s", len(patch), sha256.Sum256(patch), patch)
	check(bytes.Contains(patch, []byte("-alpha\n+beta\n")), "missing text change")

	exists, err := pb.NewRepositoryServiceClient(conn).RepositoryExists(ctx, &pb.RepositoryExistsRequest{Repository: repository})
	must(err)
	check(exists.GetExists(), "fixture repository missing")
	fmt.Printf("RepositoryExists(default, fixture.git): %v\n", exists.GetExists())
	missing, err := pb.NewRepositoryServiceClient(conn).RepositoryExists(ctx, &pb.RepositoryExistsRequest{
		Repository: &pb.Repository{StorageName: "default", RelativePath: "absent.git"},
	})
	must(err)
	check(!missing.GetExists(), "absent repository exists")
	fmt.Printf("RepositoryExists(default, absent.git): %v\n", missing.GetExists())

	c, err := sdk.Dial(ctx, address, sdk.WithToken(token), sdk.WithStorage("default"))
	must(err)
	defer c.Close()
	r := c.Repo("fixture.git")
	resolved, err := r.ResolveRevision(ctx, "refs/heads/main")
	must(err)
	check(resolved == head && head != base, "main did not move to candidate")
	fmt.Printf("ResolveRevision(refs/heads/main): %s\n", resolved)
	resolved, err = r.ResolveRevision(ctx, base)
	must(err)
	check(resolved == base, "base did not remain addressable")
	fmt.Printf("ResolveRevision(base): %s\n", resolved)
	for _, item := range []struct{ revision, want string }{{base, "alpha\n"}, {head, "beta\n"}} {
		data, err := r.ReadFile(ctx, item.revision, "README.md")
		must(err)
		check(string(data) == item.want, "unexpected pinned file contents")
		fmt.Printf("ReadFile(%s, README.md): %q\n", item.revision, data)
	}
	entries, err := r.ListTree(ctx, head, "", true)
	must(err)
	wantEntries := map[string]sdk.TreeEntry{
		"README.md":     {Path: "README.md", OID: "65b2df87f7df3aeedef04be96703e55ac19c2cfb", Type: sdk.ObjectBlob, Mode: 0100644, Size: 5},
		"docs":          {Path: "docs", OID: "07735aababbf49a3c53f57b52817377f10422782", Type: sdk.ObjectTree, Mode: 0040000, Size: 0},
		"docs/info.txt": {Path: "docs/info.txt", OID: "ee8c1ee49b4799bbd170233915a897c19e3b55e1", Type: sdk.ObjectBlob, Mode: 0100644, Size: 8},
	}
	check(len(entries) == len(wantEntries), "unexpected tree entry count")
	for _, entry := range entries {
		want, ok := wantEntries[entry.Path]
		check(ok && entry == want, "unexpected tree metadata: "+entry.Path)
		delete(wantEntries, entry.Path)
		fmt.Printf("GetTree: path=%q oid=%s type=%s mode=%o size=%d\n", entry.Path, entry.OID, entry.Type, entry.Mode, entry.Size)
	}
	_, err = r.ResolveRevision(ctx, "refs/heads/absent")
	expect("missing revision", err, codes.NotFound)
	_, err = r.ReadFile(ctx, head, "absent.txt")
	expect("missing path", err, codes.NotFound)
	_, err = r.ReadFile(ctx, head, "docs")
	expect("directory read", err, codes.FailedPrecondition)
	objects, err := r.GetObjects(ctx, []string{"1111111111111111111111111111111111111111"})
	must(err)
	check(len(objects) == 1 && objects[0].Missing, "missing object flag not preserved")
	fmt.Printf("GetObjects(absent): %+v\n", objects)
	empty, err := rawDiff(ctx, conn, repository, base, base)
	must(err)
	check(len(empty) == 0, "same-commit diff was not empty")
	fmt.Printf("RawDiff(base, base): bytes=%d\n", len(empty))
	_, err = rawDiff(ctx, conn, repository, base, "1111111111111111111111111111111111111111")
	expect("RawDiff with missing commit", err, codes.Internal)
	fmt.Println("probe assertions passed")
}
