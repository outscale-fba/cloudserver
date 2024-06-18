const assert = require('assert');
const async = require('async');
const crypto = require('crypto');
const { models, versioning } = require('arsenal');
const versionIdUtils = versioning.VersionID;
const { ObjectMD } = models;

const { makeRequest, makeBackbeatRequest } = require('../../utils/makeRequest');
const BucketUtility = require('../../../aws-node-sdk/lib/utility/bucket-util');

const ipAddress = process.env.IP ? process.env.IP : '127.0.0.1';
const describeSkipIfAWS = process.env.AWS_ON_AIR ? describe.skip : describe;

const backbeatAuthCredentials = {
    accessKey: 'accessKey1',
    secretKey: 'verySecretKey1',
};

const TEST_BUCKET = 'backbeatbucket';
const TEST_ENCRYPTED_BUCKET = 'backbeatbucket-encrypted';
const TEST_KEY = 'fookey';
const NONVERSIONED_BUCKET = 'backbeatbucket-non-versioned';
const BUCKET_FOR_NULL_VERSION = 'backbeatbucket-null-version';

const testArn = 'aws::iam:123456789012:user/bart';
const testKey = 'testkey';
const testKeyUTF8 = '䆩鈁櫨㟔罳';
const testData = 'testkey data';
const testDataMd5 = crypto.createHash('md5')
          .update(testData, 'utf-8')
          .digest('hex');
const emptyContentsMd5 = 'd41d8cd98f00b204e9800998ecf8427e';
const testMd = {
    'md-model-version': 2,
    'owner-display-name': 'Bart',
    'owner-id': ('79a59df900b949e55d96a1e698fbaced' +
                 'fd6e09d98eacf8f8d5218e7cd47ef2be'),
    'last-modified': '2017-05-15T20:32:40.032Z',
    'content-length': testData.length,
    'content-md5': testDataMd5,
    'x-amz-server-version-id': '',
    'x-amz-storage-class': 'STANDARD',
    'x-amz-server-side-encryption': '',
    'x-amz-server-side-encryption-aws-kms-key-id': '',
    'x-amz-server-side-encryption-customer-algorithm': '',
    'location': null,
    'acl': {
        Canned: 'private',
        FULL_CONTROL: [],
        WRITE_ACP: [],
        READ: [],
        READ_ACP: [],
    },
    'nullVersionId': '99999999999999999999RG001  ',
    'isDeleteMarker': false,
    'versionId': '98505119639965999999RG001  ',
    'replicationInfo': {
        status: 'COMPLETED',
        backends: [{ site: 'zenko', status: 'PENDING' }],
        content: ['DATA', 'METADATA'],
        destination: 'arn:aws:s3:::dummy-dest-bucket',
        storageClass: 'STANDARD',
    },
};

function checkObjectData(s3, objectKey, dataValue, done) {
    s3.getObject({
        Bucket: TEST_BUCKET,
        Key: objectKey,
    }, (err, data) => {
        assert.ifError(err);
        assert.strictEqual(data.Body.toString(), dataValue);
        done();
    });
}

function checkVersionData(s3, bucket, objectKey, versionId, dataValue, done) {
    return s3.getObject({
        Bucket: bucket,
        Key: objectKey,
        VersionId: versionId,
    }, (err, data) => {
        assert.ifError(err);
        assert.strictEqual(data.Body.toString(), dataValue);
        return done();
    });
}

function updateStorageClass(data, storageClass) {
    let parsedBody;
    try {
        parsedBody = JSON.parse(data.body);
    } catch (err) {
        return { error: err };
    }
    const { result, error } = ObjectMD.createFromBlob(parsedBody.Body);
    if (error) {
        return { error };
    }
    result.setAmzStorageClass(storageClass);
    return { result };
}

function getMetadataToPut(putDataResponse) {
    const mdToPut = Object.assign({}, testMd);
    // Reproduce what backbeat does to update target metadata
    mdToPut.location = JSON.parse(putDataResponse.body);
    ['x-amz-server-side-encryption',
     'x-amz-server-side-encryption-aws-kms-key-id',
     'x-amz-server-side-encryption-customer-algorithm'].forEach(headerName => {
         if (putDataResponse.headers[headerName]) {
             mdToPut[headerName] = putDataResponse.headers[headerName];
         }
     });
    return mdToPut;
}

describeSkipIfAWS('backbeat routes', () => {
    let bucketUtil;
    let s3;

    before(done => {
        bucketUtil = new BucketUtility(
            'default', { signatureVersion: 'v4' });
        s3 = bucketUtil.s3;
        bucketUtil.emptyManyIfExists([TEST_BUCKET, TEST_ENCRYPTED_BUCKET, NONVERSIONED_BUCKET])
            .then(() => s3.createBucket({ Bucket: TEST_BUCKET }).promise())
            .then(() => s3.putBucketVersioning(
                {
                    Bucket: TEST_BUCKET,
                    VersioningConfiguration: { Status: 'Enabled' },
                }).promise())
            .then(() => s3.createBucket({
                Bucket: NONVERSIONED_BUCKET,
            }).promise())
            .then(() => s3.createBucket({ Bucket: TEST_ENCRYPTED_BUCKET }).promise())
            .then(() => s3.putBucketVersioning(
                {
                    Bucket: TEST_ENCRYPTED_BUCKET,
                    VersioningConfiguration: { Status: 'Enabled' },
                }).promise())
            .then(() => s3.putBucketEncryption(
                {
                    Bucket: TEST_ENCRYPTED_BUCKET,
                    ServerSideEncryptionConfiguration: {
                        Rules: [
                            {
                                ApplyServerSideEncryptionByDefault: {
                                    SSEAlgorithm: 'AES256',
                                },
                            },
                        ],
                    },
                }).promise())
            .then(() => done())
            .catch(err => {
                process.stdout.write(`Error creating bucket: ${err}\n`);
                throw err;
            });
    });

    after(done =>
        bucketUtil.empty(TEST_BUCKET)
            .then(() => s3.deleteBucket({ Bucket: TEST_BUCKET }).promise())
            .then(() => bucketUtil.empty(TEST_ENCRYPTED_BUCKET))
            .then(() => s3.deleteBucket({ Bucket: TEST_ENCRYPTED_BUCKET }).promise())
            .then(() =>
                s3.deleteBucket({ Bucket: NONVERSIONED_BUCKET }).promise())
            .then(() => done(), err => done(err))
    );

    describe('null version', () => {
        const bucket = BUCKET_FOR_NULL_VERSION;
        const keyName = 'key0';
        const storageClass = 'foo';

        function assertVersionIsNullAndUpdated(version) {
            const { Key, VersionId, StorageClass } = version;
            assert.strictEqual(Key, keyName);
            assert.strictEqual(VersionId, 'null');
            assert.strictEqual(StorageClass, storageClass);
        }

        function assertVersionHasNotBeenUpdated(version, expectedVersionId) {
            const { Key, VersionId, StorageClass } = version;
            assert.strictEqual(Key, keyName);
            assert.strictEqual(VersionId, expectedVersionId);
            assert.strictEqual(StorageClass, 'STANDARD');
        }

        beforeEach(done =>
            bucketUtil.emptyIfExists(BUCKET_FOR_NULL_VERSION)
                .then(() => s3.createBucket({ Bucket: BUCKET_FOR_NULL_VERSION }).promise())
                .then(() => done(), err => done(err))
        );

        afterEach(done =>
            bucketUtil.empty(BUCKET_FOR_NULL_VERSION)
                .then(() => s3.deleteBucket({ Bucket: BUCKET_FOR_NULL_VERSION }).promise())
                .then(() => done(), err => done(err))
        );

        it('should update metadata of a current null version', done => {
            let objMD;
            return async.series([
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } },
                    next),
                next => makeBackbeatRequest({
                    method: 'GET',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    const { error, result } = updateStorageClass(data, storageClass);
                    if (error) {
                        return next(error);
                    }
                    objMD = result;
                    return next();
                }),
                next => makeBackbeatRequest({
                    method: 'PUT',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: objMD.getSerialized(),
                }, next),
                next => s3.headObject({ Bucket: bucket, Key: keyName, VersionId: 'null' }, next),
                next => s3.listObjectVersions({ Bucket: bucket }, next),
            ], (err, data) => {
                if (err) {
                    return done(err);
                }
                const headObjectRes = data[4];
                assert.strictEqual(headObjectRes.VersionId, 'null');
                assert.strictEqual(headObjectRes.StorageClass, storageClass);

                const listObjectVersionsRes = data[5];
                const { Versions } = listObjectVersionsRes;

                assert.strictEqual(Versions.length, 1);

                const [currentVersion] = Versions;
                assertVersionIsNullAndUpdated(currentVersion);
                return done();
            });
        });

        it('should update metadata of a non-current null version', done => {
            let objMD;
            let expectedVersionId;
            return async.series([
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } },
                    next),
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    expectedVersionId = data.VersionId;
                    return next();
                }),
                next => makeBackbeatRequest({
                    method: 'GET',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    const { error, result } = updateStorageClass(data, storageClass);
                    if (error) {
                        return next(error);
                    }
                    objMD = result;
                    return next();
                }),
                next => makeBackbeatRequest({
                    method: 'PUT',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: objMD.getSerialized(),
                }, next),
                next => s3.headObject({ Bucket: bucket, Key: keyName, VersionId: 'null' }, next),
                next => s3.listObjectVersions({ Bucket: bucket }, next),
            ], (err, data) => {
                if (err) {
                    return done(err);
                }
                const headObjectRes = data[5];
                assert.strictEqual(headObjectRes.VersionId, 'null');
                assert.strictEqual(headObjectRes.StorageClass, storageClass);

                const listObjectVersionsRes = data[6];
                const { Versions } = listObjectVersionsRes;

                assert.strictEqual(Versions.length, 2);

                const currentVersion = Versions.find(v => v.IsLatest);
                assertVersionHasNotBeenUpdated(currentVersion, expectedVersionId);

                const nonCurrentVersion = Versions.find(v => !v.IsLatest);
                assertVersionIsNullAndUpdated(nonCurrentVersion);
                return done();
            });
        });

        it('should update metadata of a suspended null version', done => {
            let objMD;
            return async.series({
                suspendVersioning: next => s3.putBucketVersioning(
                    { Bucket: bucket, VersioningConfiguration: { Status: 'Suspended' } }, next),
                putObject: next => s3.putObject(
                    { Bucket: bucket, Key: keyName, Body: Buffer.from(testData) }, next),
                enableVersioning: next => s3.putBucketVersioning(
                    { Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }, next),
                getMetadata: next => makeBackbeatRequest({
                    method: 'GET',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    const { error, result } = updateStorageClass(data, storageClass);
                    if (error) {
                        return next(error);
                    }
                    objMD = result;
                    return next();
                }),
                putUpdatedMetadata: next => makeBackbeatRequest({
                    method: 'PUT',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: objMD.getSerialized(),
                }, next),
                headObject: next => s3.headObject({ Bucket: bucket, Key: keyName, VersionId: 'null' }, next),
                listObjectVersions: next => s3.listObjectVersions({ Bucket: bucket }, next),
            }, (err, results) => {
                if (err) {
                    return done(err);
                }
                const headObjectRes = results.headObject;
                assert.strictEqual(headObjectRes.VersionId, 'null');
                assert.strictEqual(headObjectRes.StorageClass, storageClass);

                const listObjectVersionsRes = results.listObjectVersions;
                const { Versions } = listObjectVersionsRes;

                assert.strictEqual(Versions.length, 1);

                const [currentVersion] = Versions;
                assertVersionIsNullAndUpdated(currentVersion);
                return done();
            });
        });

        it('should update metadata of a suspended null version with internal version id', done => {
            let objMD;
            return async.series({
                suspendVersioning: next => s3.putBucketVersioning(
                    { Bucket: bucket, VersioningConfiguration: { Status: 'Suspended' } }, next),
                putObject: next => s3.putObject(
                    { Bucket: bucket, Key: keyName, Body: Buffer.from(testData) }, next),
                enableVersioning: next => s3.putBucketVersioning(
                    { Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }, next),
                putObjectTagging: next => s3.putObjectTagging({
                    Bucket: bucket, Key: keyName, VersionId: 'null',
                    Tagging: { TagSet: [{ Key: 'key1', Value: 'value1' }] },
                }, next),
                getMetadata: next => makeBackbeatRequest({
                    method: 'GET',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    const { error, result } = updateStorageClass(data, storageClass);
                    if (error) {
                        return next(error);
                    }
                    objMD = result;
                    return next();
                }),
                putUpdatedMetadata: next => makeBackbeatRequest({
                    method: 'PUT',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: objMD.getSerialized(),
                }, next),
                headObject: next => s3.headObject({ Bucket: bucket, Key: keyName, VersionId: 'null' }, next),
                listObjectVersions: next => s3.listObjectVersions({ Bucket: bucket }, next),
            }, (err, results) => {
                if (err) {
                    return done(err);
                }
                const headObjectRes = results.headObject;
                assert.strictEqual(headObjectRes.VersionId, 'null');
                assert.strictEqual(headObjectRes.StorageClass, storageClass);

                const listObjectVersionsRes = results.listObjectVersions;
                const { Versions } = listObjectVersionsRes;

                assert.strictEqual(Versions.length, 1);

                const [currentVersion] = Versions;
                assertVersionIsNullAndUpdated(currentVersion);
                return done();
            });
        });

        // Skipping is necessary because non-versioned buckets are not supported by S3C backbeat routes.
        it.skip('should update metadata of a non-version object', done => {
            let objMD;
            return async.series([
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                next => makeBackbeatRequest({
                    method: 'GET',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    const { error, result } = updateStorageClass(data, storageClass);
                    if (error) {
                        return next(error);
                    }
                    objMD = result;
                    return next();
                }),
                next => makeBackbeatRequest({
                    method: 'PUT',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: objMD.getSerialized(),
                }, next),
                next => s3.headObject({ Bucket: bucket, Key: keyName }, next),
                next => s3.listObjectVersions({ Bucket: bucket }, next),
            ], (err, data) => {
                if (err) {
                    return done(err);
                }

                const headObjectRes = data[3];
                assert(!headObjectRes.VersionId);
                assert.strictEqual(headObjectRes.StorageClass, storageClass);

                const listObjectVersionsRes = data[4];
                const { DeleteMarkers, Versions } = listObjectVersionsRes;

                assert.strictEqual(DeleteMarkers.length, 0);
                assert.strictEqual(Versions.length, 1);

                const currentVersion = Versions[0];
                assert(currentVersion.IsLatest);
                assertVersionIsNullAndUpdated(currentVersion);
                return done();
            });
        });

        it.skip('should create a new null version if versioning suspended and no version', done => {
            let objMD;
            return async.series([
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Suspended' } },
                    next),
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                next => makeBackbeatRequest({
                    method: 'GET',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    const { error, result } = updateStorageClass(data, storageClass);
                    if (error) {
                        return next(error);
                    }
                    objMD = result;
                    return next();
                }),
                next => s3.deleteObject({ Bucket: bucket, Key: keyName, VersionId: 'null' }, next),
                next => makeBackbeatRequest({
                    method: 'PUT',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: objMD.getSerialized(),
                }, next),
                next => s3.headObject({ Bucket: bucket, Key: keyName }, next),
                next => s3.listObjectVersions({ Bucket: bucket }, next),
            ], (err, data) => {
                if (err) {
                    return done(err);
                }
                const headObjectRes = data[5];
                assert.strictEqual(headObjectRes.VersionId, 'null');
                assert.strictEqual(headObjectRes.StorageClass, storageClass);

                const listObjectVersionsRes = data[6];
                const { DeleteMarkers, Versions } = listObjectVersionsRes;

                assert.strictEqual(DeleteMarkers.length, 0);
                assert.strictEqual(Versions.length, 1);

                const currentVersion = Versions[0];
                assert(currentVersion.IsLatest);

                assertVersionIsNullAndUpdated(currentVersion);

                return done();
            });
        });

        it.skip('should create a new null version if versioning suspended and delete marker null version', done => {
            let objMD;
            return async.series([
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Suspended' } },
                    next),
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                next => makeBackbeatRequest({
                    method: 'GET',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    const { error, result } = updateStorageClass(data, storageClass);
                    if (error) {
                        return next(error);
                    }
                    objMD = result;
                    return next();
                }),
                next => s3.deleteObject({ Bucket: bucket, Key: keyName }, next),
                next => makeBackbeatRequest({
                    method: 'PUT',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: objMD.getSerialized(),
                }, next),
                next => s3.headObject({ Bucket: bucket, Key: keyName }, next),
                next => s3.listObjectVersions({ Bucket: bucket }, next),
            ], (err, data) => {
                if (err) {
                    return done(err);
                }
                const headObjectRes = data[5];
                assert.strictEqual(headObjectRes.VersionId, 'null');
                assert.strictEqual(headObjectRes.StorageClass, storageClass);

                const listObjectVersionsRes = data[6];
                const { DeleteMarkers, Versions } = listObjectVersionsRes;

                assert.strictEqual(DeleteMarkers.length, 0);
                assert.strictEqual(Versions.length, 1);

                const currentVersion = Versions[0];
                assert(currentVersion.IsLatest);
                assertVersionIsNullAndUpdated(currentVersion);
                return done();
            });
        });

        it.skip('should create a new null version if versioning suspended and version has version id', done => {
            let expectedVersionId;
            let objMD;
            return async.series([
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } },
                    next),
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    expectedVersionId = data.VersionId;
                    return next();
                }),
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Suspended' } },
                    next),
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                next => makeBackbeatRequest({
                    method: 'GET',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: null,
                    },
                    authCredentials: backbeatAuthCredentials,
                }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    const { error, result } = updateStorageClass(data, storageClass);
                    if (error) {
                        return next(error);
                    }
                    objMD = result;
                    return next();
                }),
                next => s3.deleteObject({ Bucket: bucket, Key: keyName, VersionId: 'null' }, next),
                next => makeBackbeatRequest({
                    method: 'PUT',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: objMD.getSerialized(),
                }, next),
                next => s3.headObject({ Bucket: bucket, Key: keyName }, next),
                next => s3.listObjectVersions({ Bucket: bucket }, next),
            ], (err, data) => {
                if (err) {
                    return done(err);
                }
                const headObjectRes = data[7];
                assert.strictEqual(headObjectRes.VersionId, 'null');
                assert.strictEqual(headObjectRes.StorageClass, storageClass);

                const listObjectVersionsRes = data[8];
                const { DeleteMarkers, Versions } = listObjectVersionsRes;

                assert.strictEqual(DeleteMarkers.length, 0);
                assert.strictEqual(Versions.length, 2);

                const currentVersion = Versions.find(v => v.IsLatest);
                assertVersionIsNullAndUpdated(currentVersion);

                const nonCurrentVersion = Versions.find(v => !v.IsLatest);
                assertVersionHasNotBeenUpdated(nonCurrentVersion, expectedVersionId);

                // give some time for the async deletes to complete
                return setTimeout(() => checkVersionData(s3, bucket, keyName, expectedVersionId, testData, done),
                       1000);
            });
        });

        it.skip('should update null version with no version id and versioning suspended', done => {
            let objMD;
            return async.series([
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Suspended' } },
                    next),
                next => makeBackbeatRequest({
                    method: 'GET',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    const { error, result } = updateStorageClass(data, storageClass);
                    if (error) {
                        return next(error);
                    }
                    objMD = result;
                    return next();
                }),
                next => makeBackbeatRequest({
                    method: 'PUT',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: objMD.getSerialized(),
                }, next),
                next => s3.headObject({ Bucket: bucket, Key: keyName }, next),
                next => s3.listObjectVersions({ Bucket: bucket }, next),
            ], (err, data) => {
                if (err) {
                    return done(err);
                }
                const headObjectRes = data[4];
                assert.strictEqual(headObjectRes.VersionId, 'null');
                assert.strictEqual(headObjectRes.StorageClass, storageClass);

                const listObjectVersionsRes = data[5];
                const { DeleteMarkers, Versions } = listObjectVersionsRes;
                assert.strictEqual(DeleteMarkers.length, 0);
                assert.strictEqual(Versions.length, 1);

                const currentVersion = Versions[0];
                assert(currentVersion.IsLatest);
                assertVersionIsNullAndUpdated(currentVersion);

                return done();
            });
        });

        it.skip('should update null version if versioning suspended and null version has a version id', done => {
            let objMD;
            return async.series([
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Suspended' } },
                    next),
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                next => makeBackbeatRequest({
                    method: 'GET',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    const { error, result } = updateStorageClass(data, storageClass);
                    if (error) {
                        return next(error);
                    }
                    objMD = result;
                    return next();
                }),
                next => makeBackbeatRequest({
                    method: 'PUT',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: objMD.getSerialized(),
                }, next),
                next => s3.headObject({ Bucket: bucket, Key: keyName, VersionId: 'null' }, next),
                next => s3.listObjectVersions({ Bucket: bucket }, next),
            ], (err, data) => {
                if (err) {
                    return done(err);
                }

                const headObjectRes = data[4];
                assert.strictEqual(headObjectRes.VersionId, 'null');
                assert.strictEqual(headObjectRes.StorageClass, storageClass);

                const listObjectVersionsRes = data[5];
                const { DeleteMarkers, Versions } = listObjectVersionsRes;
                assert.strictEqual(Versions.length, 1);
                assert.strictEqual(DeleteMarkers.length, 0);

                const currentVersion = Versions[0];
                assert(currentVersion.IsLatest);
                assertVersionIsNullAndUpdated(currentVersion);
                return done();
            });
        });

        it.skip('should update null version if versioning suspended and null version has a version id and' +
        'put object afterward', done => {
            let objMD;
            return async.series([
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Suspended' } },
                    next),
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                next => makeBackbeatRequest({
                    method: 'GET',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    const { error, result } = updateStorageClass(data, storageClass);
                    if (error) {
                        return next(error);
                    }
                    objMD = result;
                    return next();
                }),
                next => makeBackbeatRequest({
                    method: 'PUT',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: objMD.getSerialized(),
                }, next),
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                next => s3.headObject({ Bucket: bucket, Key: keyName, VersionId: 'null' }, next),
                next => s3.listObjectVersions({ Bucket: bucket }, next),
            ], (err, data) => {
                if (err) {
                    return done(err);
                }

                const headObjectRes = data[5];
                assert.strictEqual(headObjectRes.VersionId, 'null');
                assert(!headObjectRes.StorageClass);

                const listObjectVersionsRes = data[6];
                const { DeleteMarkers, Versions } = listObjectVersionsRes;
                assert.strictEqual(DeleteMarkers.length, 0);
                assert.strictEqual(Versions.length, 1);

                const currentVersion = Versions[0];
                assert(currentVersion.IsLatest);
                assertVersionHasNotBeenUpdated(currentVersion, 'null');
                return done();
            });
        });

        it.skip('should update null version if versioning suspended and null version has a version id and' +
        'put version afterward', done => {
            let objMD;
            let expectedVersionId;
            return async.series([
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Suspended' } },
                    next),
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                next => makeBackbeatRequest({
                    method: 'GET',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    const { error, result } = updateStorageClass(data, storageClass);
                    if (error) {
                        return next(error);
                    }
                    objMD = result;
                    return next();
                }),
                next => makeBackbeatRequest({
                    method: 'PUT',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: objMD.getSerialized(),
                }, next),
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } },
                    next),
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    expectedVersionId = data.VersionId;
                    return next();
                }),
                next => s3.headObject({ Bucket: bucket, Key: keyName, VersionId: 'null' }, next),
                next => s3.listObjectVersions({ Bucket: bucket }, next),
            ], (err, data) => {
                if (err) {
                    return done(err);
                }

                const headObjectRes = data[6];
                assert.strictEqual(headObjectRes.VersionId, 'null');
                assert.strictEqual(headObjectRes.StorageClass, storageClass);

                const listObjectVersionsRes = data[7];
                const { Versions } = listObjectVersionsRes;
                assert.strictEqual(Versions.length, 2);

                const [currentVersion] = Versions.filter(v => v.IsLatest);
                assertVersionHasNotBeenUpdated(currentVersion, expectedVersionId);

                const [nonCurrentVersion] = Versions.filter(v => !v.IsLatest);
                assertVersionIsNullAndUpdated(nonCurrentVersion);
                return done();
            });
        });

        it.skip('should update non-current null version if versioning suspended', done => {
            let expectedVersionId;
            let objMD;
            return async.series([
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } },
                    next),
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    expectedVersionId = data.VersionId;
                    return next();
                }),
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Suspended' } },
                    next),
                next => makeBackbeatRequest({
                    method: 'GET',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    const { error, result } = updateStorageClass(data, storageClass);
                    if (error) {
                        return next(error);
                    }
                    objMD = result;
                    return next();
                }),
                next => makeBackbeatRequest({
                    method: 'PUT',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: objMD.getSerialized(),
                }, next),
                next => s3.headObject({ Bucket: bucket, Key: keyName, VersionId: 'null' }, next),
                next => s3.listObjectVersions({ Bucket: bucket }, next),
            ], (err, data) => {
                if (err) {
                    return done(err);
                }

                const headObjectRes = data[6];
                assert.strictEqual(headObjectRes.VersionId, 'null');
                assert.strictEqual(headObjectRes.StorageClass, storageClass);

                const listObjectVersionsRes = data[7];
                const deleteMarkers = listObjectVersionsRes.DeleteMarkers;
                assert.strictEqual(deleteMarkers.length, 0);
                const { Versions } = listObjectVersionsRes;
                assert.strictEqual(Versions.length, 2);

                const [currentVersion] = Versions.filter(v => v.IsLatest);
                assertVersionHasNotBeenUpdated(currentVersion, expectedVersionId);

                const [nonCurrentVersion] = Versions.filter(v => !v.IsLatest);
                assertVersionIsNullAndUpdated(nonCurrentVersion);

                return done();
            });
        });

        it.skip('should update current null version if versioning suspended', done => {
            let objMD;
            let expectedVersionId;
            return async.series([
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } },
                    next),
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    expectedVersionId = data.VersionId;
                    return next();
                }),
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Suspended' } },
                    next),
                next => s3.deleteObject({ Bucket: bucket, Key: keyName, VersionId: expectedVersionId }, next),
                next => makeBackbeatRequest({
                    method: 'GET',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    const { error, result } = updateStorageClass(data, storageClass);
                    if (error) {
                        return next(error);
                    }
                    objMD = result;
                    return next();
                }),
                next => makeBackbeatRequest({
                    method: 'PUT',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: objMD.getSerialized(),
                }, next),
                next => s3.headObject({ Bucket: bucket, Key: keyName, VersionId: 'null' }, next),
                next => s3.listObjectVersions({ Bucket: bucket }, next),
            ], (err, data) => {
                if (err) {
                    return done(err);
                }

                const headObjectRes = data[7];
                assert.strictEqual(headObjectRes.VersionId, 'null');
                assert.strictEqual(headObjectRes.StorageClass, storageClass);

                const listObjectVersionsRes = data[8];
                const { DeleteMarkers, Versions } = listObjectVersionsRes;
                assert.strictEqual(Versions.length, 1);
                assert.strictEqual(DeleteMarkers.length, 0);

                const currentVersion = Versions[0];
                assert(currentVersion.IsLatest);
                assertVersionIsNullAndUpdated(currentVersion);
                return done();
            });
        });

        it.skip('should update current null version if versioning suspended and put a null version ' +
        'afterwards', done => {
            let objMD;
            let deletedVersionId;
            return async.series([
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } },
                    next),
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    deletedVersionId = data.VersionId;
                    return next();
                }),
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Suspended' } },
                    next),
                next => s3.deleteObject({ Bucket: bucket, Key: keyName, VersionId: deletedVersionId }, next),
                next => makeBackbeatRequest({
                    method: 'GET',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    const { error, result } = updateStorageClass(data, storageClass);
                    if (error) {
                        return next(error);
                    }
                    objMD = result;
                    return next();
                }),
                next => makeBackbeatRequest({
                    method: 'PUT',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: objMD.getSerialized(),
                }, next),
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                next => s3.headObject({ Bucket: bucket, Key: keyName, VersionId: 'null' }, next),
                next => s3.listObjectVersions({ Bucket: bucket }, next),
            ], (err, data) => {
                if (err) {
                    return done(err);
                }

                const headObjectRes = data[8];
                assert.strictEqual(headObjectRes.VersionId, 'null');
                assert(!headObjectRes.StorageClass);

                const listObjectVersionsRes = data[9];
                const { DeleteMarkers, Versions } = listObjectVersionsRes;
                assert.strictEqual(DeleteMarkers.length, 0);
                assert.strictEqual(Versions.length, 1);

                const currentVersion = Versions[0];
                assert(currentVersion.IsLatest);
                assertVersionHasNotBeenUpdated(currentVersion, 'null');

                return done();
            });
        });

        it.skip('should update current null version if versioning suspended and put a version afterwards', done => {
            let objMD;
            let deletedVersionId;
            let expectedVersionId;
            return async.series([
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, next),
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } },
                    next),
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    deletedVersionId = data.VersionId;
                    return next();
                }),
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Suspended' } },
                    next),
                next => s3.deleteObject({ Bucket: bucket, Key: keyName, VersionId: deletedVersionId }, next),
                next => makeBackbeatRequest({
                    method: 'GET',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    const { error, result } = updateStorageClass(data, storageClass);
                    if (error) {
                        return next(error);
                    }
                    objMD = result;
                    return next();
                }),
                next => makeBackbeatRequest({
                    method: 'PUT',
                    resourceType: 'metadata',
                    bucket,
                    objectKey: keyName,
                    queryObj: {
                        versionId: 'null',
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: objMD.getSerialized(),
                }, next),
                next => s3.putBucketVersioning({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } },
                    next),
                next => s3.putObject({ Bucket: bucket, Key: keyName, Body: new Buffer(testData) }, (err, data) => {
                    if (err) {
                        return next(err);
                    }
                    expectedVersionId = data.VersionId;
                    return next();
                }),
                next => s3.headObject({ Bucket: bucket, Key: keyName, VersionId: 'null' }, next),
                next => s3.listObjectVersions({ Bucket: bucket }, next),
            ], (err, data) => {
                if (err) {
                    return done(err);
                }

                const headObjectRes = data[9];
                assert.strictEqual(headObjectRes.VersionId, 'null');
                assert.strictEqual(headObjectRes.StorageClass, storageClass);

                const listObjectVersionsRes = data[10];
                const { DeleteMarkers, Versions } = listObjectVersionsRes;
                assert.strictEqual(DeleteMarkers.length, 0);
                assert.strictEqual(Versions.length, 2);

                const [currentVersion] = Versions.filter(v => v.IsLatest);
                assertVersionHasNotBeenUpdated(currentVersion, expectedVersionId);

                const [nonCurrentVersion] = Versions.filter(v => !v.IsLatest);
                assertVersionIsNullAndUpdated(nonCurrentVersion);

                return done();
            });
        });
    });

    describe('backbeat PUT routes', () => {
        describe('PUT data + metadata should create a new complete object',
        () => {
            [{
                caption: 'with ascii test key',
                key: testKey, encodedKey: testKey,
            },
            {
                caption: 'with UTF8 key',
                key: testKeyUTF8, encodedKey: encodeURI(testKeyUTF8),
            },
            {
                caption: 'with percents and spaces encoded as \'+\' in key',
                key: '50% full or 50% empty',
                encodedKey: '50%25+full+or+50%25+empty',
            },
            {
                caption: 'with legacy API v1',
                key: testKey, encodedKey: testKey,
                legacyAPI: true,
            },
            {
                caption: 'with encryption configuration',
                key: testKey, encodedKey: testKey,
                encryption: true,
            },
            {
                caption: 'with encryption configuration and legacy API v1',
                key: testKey, encodedKey: testKey,
                encryption: true,
                legacyAPI: true,
            }].concat([
                `${testKeyUTF8}/${testKeyUTF8}/%42/mykey`,
                'Pâtisserie=中文-español-English',
                'notes/spring/1.txt',
                'notes/spring/2.txt',
                'notes/spring/march/1.txt',
                'notes/summer/1.txt',
                'notes/summer/2.txt',
                'notes/summer/august/1.txt',
                'notes/year.txt',
                'notes/yore.rs',
                'notes/zaphod/Beeblebrox.txt',
            ].map(key => ({
                key, encodedKey: encodeURI(key),
                caption: `with key ${key}`,
            })))
            .forEach(testCase => {
                it(testCase.caption, done => {
                    async.waterfall([next => {
                        const queryObj = testCase.legacyAPI ? {} : { v2: '' };
                        makeBackbeatRequest({
                            method: 'PUT', bucket: testCase.encryption ?
                                TEST_ENCRYPTED_BUCKET : TEST_BUCKET,
                            objectKey: testCase.encodedKey,
                            resourceType: 'data',
                            queryObj,
                            headers: {
                                'content-length': testData.length,
                                'x-scal-canonical-id': testArn,
                            },
                            authCredentials: backbeatAuthCredentials,
                            requestBody: testData }, next);
                    }, (response, next) => {
                        assert.strictEqual(response.statusCode, 200);
                        const newMd = getMetadataToPut(response);
                        if (testCase.encryption && !testCase.legacyAPI) {
                            assert.strictEqual(typeof newMd.location[0].cryptoScheme, 'number');
                            assert.strictEqual(typeof newMd.location[0].cipheredDataKey, 'string');
                        } else {
                            // if no encryption or legacy API, data should not be encrypted
                            assert.strictEqual(newMd.location[0].cryptoScheme, undefined);
                            assert.strictEqual(newMd.location[0].cipheredDataKey, undefined);
                        }
                        makeBackbeatRequest({
                            method: 'PUT', bucket: testCase.encryption ?
                                TEST_ENCRYPTED_BUCKET : TEST_BUCKET,
                            objectKey: testCase.encodedKey,
                            resourceType: 'metadata',
                            queryObj: {
                                versionId: versionIdUtils.encode(
                                    testMd.versionId),
                            },
                            authCredentials: backbeatAuthCredentials,
                            requestBody: JSON.stringify(newMd),
                        }, next);
                    }, (response, next) => {
                        assert.strictEqual(response.statusCode, 200);
                        s3.getObject({
                            Bucket: testCase.encryption ?
                                TEST_ENCRYPTED_BUCKET : TEST_BUCKET,
                            Key: testCase.key,
                        }, (err, data) => {
                            assert.ifError(err);
                            assert.strictEqual(data.Body.toString(), testData);
                            next();
                        });
                    }], err => {
                        assert.ifError(err);
                        done();
                    });
                });
            });
        });

        it('PUT metadata with "x-scal-replication-content: METADATA"' +
        'header should replicate metadata only', done => {
            async.waterfall([next => {
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_ENCRYPTED_BUCKET,
                    objectKey: 'test-updatemd-key',
                    resourceType: 'data',
                    queryObj: { v2: '' },
                    headers: {
                        'content-length': testData.length,
                        'x-scal-canonical-id': testArn,
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: testData,
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                const newMd = getMetadataToPut(response);
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_ENCRYPTED_BUCKET,
                    objectKey: 'test-updatemd-key',
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(newMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // Don't update the sent metadata since it is sent by
                // backbeat as received from the replication queue,
                // without updated data location or encryption info
                // (since that info is not known by backbeat)
                const newMd = Object.assign({}, testMd);
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_ENCRYPTED_BUCKET,
                    objectKey: 'test-updatemd-key',
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    headers: { 'x-scal-replication-content': 'METADATA' },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(newMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                s3.getObject({
                    Bucket: TEST_ENCRYPTED_BUCKET,
                    Key: 'test-updatemd-key',
                }, (err, data) => {
                    assert.ifError(err);
                    assert.strictEqual(data.Body.toString(), testData);
                    next();
                });
            }], err => {
                assert.ifError(err);
                done();
            });
        });

        it('should refuse PUT data if bucket is not versioned',
        done => makeBackbeatRequest({
            method: 'PUT', bucket: NONVERSIONED_BUCKET,
            objectKey: testKey, resourceType: 'data',
            queryObj: { v2: '' },
            headers: {
                'content-length': testData.length,
                'x-scal-canonical-id': testArn,
            },
            authCredentials: backbeatAuthCredentials,
            requestBody: testData,
        },
        err => {
            assert.strictEqual(err.code, 'InvalidBucketState');
            done();
        }));

        it('should refuse PUT metadata if bucket is not versioned',
        done => makeBackbeatRequest({
            method: 'PUT', bucket: NONVERSIONED_BUCKET,
            objectKey: testKey, resourceType: 'metadata',
            queryObj: {
                versionId: versionIdUtils.encode(testMd.versionId),
            },
            authCredentials: backbeatAuthCredentials,
            requestBody: JSON.stringify(testMd),
        },
        err => {
            assert.strictEqual(err.code, 'InvalidBucketState');
            done();
        }));

        it('should refuse PUT data if no x-scal-canonical-id header ' +
           'is provided', done => makeBackbeatRequest({
               method: 'PUT', bucket: TEST_BUCKET,
               objectKey: testKey, resourceType: 'data',
               queryObj: { v2: '' },
               headers: {
                   'content-length': testData.length,
               },
               authCredentials: backbeatAuthCredentials,
               requestBody: testData,
           },
           err => {
               assert.strictEqual(err.code, 'BadRequest');
               done();
           }));

        it('should refuse PUT in metadata-only mode if object does not exist',
        done => {
            async.waterfall([next => {
                const newMd = Object.assign({}, testMd);
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: 'does-not-exist',
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    headers: { 'x-scal-replication-content': 'METADATA' },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(newMd),
                }, next);
            }], err => {
                assert.strictEqual(err.statusCode, 404);
                done();
            });
        });

        it('should remove old object data locations if version is overwritten ' +
        'with same contents', done => {
            let oldLocation;
            const testKeyOldData = `${testKey}-old-data`;
            async.waterfall([next => {
                // put object's data locations
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'data',
                    headers: {
                        'content-length': testData.length,
                        'x-scal-canonical-id': testArn,
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: testData }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // put object metadata
                const newMd = Object.assign({}, testMd);
                newMd.location = JSON.parse(response.body);
                oldLocation = newMd.location;
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(newMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // put another object which metadata reference the
                // same data locations, we will attempt to retrieve
                // this object at the end of the test to confirm that
                // its locations have been deleted
                const oldDataMd = Object.assign({}, testMd);
                oldDataMd.location = oldLocation;
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKeyOldData,
                    resourceType: 'metadata',
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(oldDataMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // create new data locations
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'data',
                    headers: {
                        'content-length': testData.length,
                        'x-scal-canonical-id': testArn,
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: testData }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // overwrite the original object version, now
                // with references to the new data locations
                const newMd = Object.assign({}, testMd);
                newMd.location = JSON.parse(response.body);
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(newMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // give some time for the async deletes to complete
                setTimeout(() => checkObjectData(s3, testKey, testData, next),
                           1000);
            }, next => {
                // check that the object copy referencing the old data
                // locations is unreadable, confirming that the old
                // data locations have been deleted
                s3.getObject({
                    Bucket: TEST_BUCKET,
                    Key: testKeyOldData,
                }, err => {
                    assert(err, 'expected error to get object with old data ' +
                           'locations, got success');
                    next();
                });
            }], err => {
                assert.ifError(err);
                done();
            });
        });

        it('should remove old object data locations if version is overwritten ' +
        'with empty contents', done => {
            let oldLocation;
            const testKeyOldData = `${testKey}-old-data`;
            async.waterfall([next => {
                // put object's data locations
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'data',
                    headers: {
                        'content-length': testData.length,
                        'x-scal-canonical-id': testArn,
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: testData }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // put object metadata
                const newMd = Object.assign({}, testMd);
                newMd.location = JSON.parse(response.body);
                oldLocation = newMd.location;
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(newMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // put another object which metadata reference the
                // same data locations, we will attempt to retrieve
                // this object at the end of the test to confirm that
                // its locations have been deleted
                const oldDataMd = Object.assign({}, testMd);
                oldDataMd.location = oldLocation;
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKeyOldData,
                    resourceType: 'metadata',
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(oldDataMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // overwrite the original object version with an empty location
                const newMd = Object.assign({}, testMd);
                newMd['content-length'] = 0;
                newMd['content-md5'] = emptyContentsMd5;
                newMd.location = null;
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(newMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // give some time for the async deletes to complete
                setTimeout(() => checkObjectData(s3, testKey, '', next),
                           1000);
            }, next => {
                // check that the object copy referencing the old data
                // locations is unreadable, confirming that the old
                // data locations have been deleted
                s3.getObject({
                    Bucket: TEST_BUCKET,
                    Key: testKeyOldData,
                }, err => {
                    assert(err, 'expected error to get object with old data ' +
                           'locations, got success');
                    next();
                });
            }], err => {
                assert.ifError(err);
                done();
            });
        });

        it('should not remove data locations on replayed metadata PUT',
        done => {
            let serializedNewMd;
            async.waterfall([next => {
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'data',
                    headers: {
                        'content-length': testData.length,
                        'x-scal-canonical-id': testArn,
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: testData }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                const newMd = Object.assign({}, testMd);
                newMd.location = JSON.parse(response.body);
                serializedNewMd = JSON.stringify(newMd);
                async.timesSeries(2, (i, putDone) => makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: serializedNewMd,
                }, (err, response) => {
                    assert.ifError(err);
                    assert.strictEqual(response.statusCode, 200);
                    putDone(err);
                }), () => next());
            }, next => {
                // check that the object is still readable to make
                // sure we did not remove the data keys
                s3.getObject({
                    Bucket: TEST_BUCKET,
                    Key: testKey,
                }, (err, data) => {
                    assert.ifError(err);
                    assert.strictEqual(data.Body.toString(), testData);
                    next();
                });
            }], err => {
                assert.ifError(err);
                done();
            });
        });

        it('should create a new version when no versionId is passed in query string', done => {
            let newVersion;
            async.waterfall([next => {
                // put object's data locations
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'data',
                    headers: {
                        'content-length': testData.length,
                        'x-scal-canonical-id': testArn,
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: testData }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // put object metadata
                const oldMd = Object.assign({}, testMd);
                oldMd.location = JSON.parse(response.body);
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'metadata',
                    queryObj: {
                        versionId: versionIdUtils.encode(testMd.versionId),
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(oldMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                const parsedResponse = JSON.parse(response.body);
                assert.strictEqual(parsedResponse.versionId, testMd.versionId);
                // create new data locations
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'data',
                    headers: {
                        'content-length': testData.length,
                        'x-scal-canonical-id': testArn,
                    },
                    authCredentials: backbeatAuthCredentials,
                    requestBody: testData }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                // create a new version with the new data locations,
                // not passing 'versionId' in the query string
                const newMd = Object.assign({}, testMd);
                newMd.location = JSON.parse(response.body);
                makeBackbeatRequest({
                    method: 'PUT', bucket: TEST_BUCKET,
                    objectKey: testKey,
                    resourceType: 'metadata',
                    authCredentials: backbeatAuthCredentials,
                    requestBody: JSON.stringify(newMd),
                }, next);
            }, (response, next) => {
                assert.strictEqual(response.statusCode, 200);
                const parsedResponse = JSON.parse(response.body);
                newVersion = parsedResponse.versionId;
                assert.notStrictEqual(newVersion, testMd.versionId);
                // give some time for the async deletes to complete,
                // then check that we can read the latest version
                setTimeout(() => s3.getObject({
                    Bucket: TEST_BUCKET,
                    Key: testKey,
                }, (err, data) => {
                    assert.ifError(err);
                    assert.strictEqual(data.Body.toString(), testData);
                    next();
                }), 1000);
            }, next => {
                // check that the previous object version is still readable
                s3.getObject({
                    Bucket: TEST_BUCKET,
                    Key: testKey,
                    VersionId: versionIdUtils.encode(testMd.versionId),
                }, (err, data) => {
                    assert.ifError(err);
                    assert.strictEqual(data.Body.toString(), testData);
                    next();
                });
            }], err => {
                assert.ifError(err);
                done();
            });
        });
    });
    describe('backbeat authorization checks', () => {
        [{ method: 'PUT', resourceType: 'metadata' },
         { method: 'PUT', resourceType: 'data' }].forEach(test => {
             const queryObj = test.resourceType === 'data' ? { v2: '' } : {};
             it(`${test.method} ${test.resourceType} should respond with ` +
             '403 Forbidden if no credentials are provided',
             done => {
                 makeBackbeatRequest({
                     method: test.method, bucket: TEST_BUCKET,
                     objectKey: TEST_KEY, resourceType: test.resourceType,
                     queryObj,
                 },
                 err => {
                     assert(err);
                     assert.strictEqual(err.statusCode, 403);
                     assert.strictEqual(err.code, 'AccessDenied');
                     done();
                 });
             });
             it(`${test.method} ${test.resourceType} should respond with ` +
                '403 Forbidden if wrong credentials are provided',
                done => {
                    makeBackbeatRequest({
                        method: test.method, bucket: TEST_BUCKET,
                        objectKey: TEST_KEY, resourceType: test.resourceType,
                        queryObj,
                        authCredentials: {
                            accessKey: 'wrong',
                            secretKey: 'still wrong',
                        },
                    },
                    err => {
                        assert(err);
                        assert.strictEqual(err.statusCode, 403);
                        assert.strictEqual(err.code, 'InvalidAccessKeyId');
                        done();
                    });
                });
             it(`${test.method} ${test.resourceType} should respond with ` +
                '403 Forbidden if the account does not match the ' +
                'backbeat user',
                done => {
                    makeBackbeatRequest({
                        method: test.method, bucket: TEST_BUCKET,
                        objectKey: TEST_KEY, resourceType: test.resourceType,
                        queryObj,
                        authCredentials: {
                            accessKey: 'accessKey2',
                            secretKey: 'verySecretKey2',
                        },
                    },
                    err => {
                        assert(err);
                        assert.strictEqual(err.statusCode, 403);
                        assert.strictEqual(err.code, 'AccessDenied');
                        done();
                    });
                });
             it(`${test.method} ${test.resourceType} should respond with ` +
                '403 Forbidden if backbeat user has wrong secret key',
                done => {
                    makeBackbeatRequest({
                        method: test.method, bucket: TEST_BUCKET,
                        objectKey: TEST_KEY, resourceType: test.resourceType,
                        queryObj,
                        authCredentials: {
                            accessKey: backbeatAuthCredentials.accessKey,
                            secretKey: 'hastalavista',
                        },
                    },
                    err => {
                        assert(err);
                        assert.strictEqual(err.statusCode, 403);
                        assert.strictEqual(err.code, 'SignatureDoesNotMatch');
                        done();
                    });
                });
         });
    });

    describe('GET Metadata route', () => {
        beforeEach(done => makeBackbeatRequest({
            method: 'PUT', bucket: TEST_BUCKET,
            objectKey: TEST_KEY,
            resourceType: 'metadata',
            queryObj: {
                versionId: versionIdUtils.encode(testMd.versionId),
            },
            authCredentials: backbeatAuthCredentials,
            requestBody: JSON.stringify(testMd),
        }, done));

        it('should return metadata blob for a versionId', done => {
            makeBackbeatRequest({
                method: 'GET', bucket: TEST_BUCKET,
                objectKey: TEST_KEY, resourceType: 'metadata',
                authCredentials: backbeatAuthCredentials,
                queryObj: {
                    versionId: versionIdUtils.encode(testMd.versionId),
                },
            }, (err, data) => {
                const parsedBody = JSON.parse(JSON.parse(data.body).Body);
                assert.strictEqual(data.statusCode, 200);
                assert.deepStrictEqual(parsedBody, testMd);
                done();
            });
        });

        it('should return error if bucket does not exist', done => {
            makeBackbeatRequest({
                method: 'GET', bucket: 'blah',
                objectKey: TEST_KEY, resourceType: 'metadata',
                authCredentials: backbeatAuthCredentials,
                queryObj: {
                    versionId: versionIdUtils.encode(testMd.versionId),
                },
            }, (err, data) => {
                assert.strictEqual(data.statusCode, 404);
                assert.strictEqual(JSON.parse(data.body).code, 'NoSuchBucket');
                done();
            });
        });

        it('should return error if object does not exist', done => {
            makeBackbeatRequest({
                method: 'GET', bucket: TEST_BUCKET,
                objectKey: 'blah', resourceType: 'metadata',
                authCredentials: backbeatAuthCredentials,
                queryObj: {
                    versionId: versionIdUtils.encode(testMd.versionId),
                },
            }, (err, data) => {
                assert.strictEqual(data.statusCode, 404);
                assert.strictEqual(JSON.parse(data.body).code, 'ObjNotFound');
                done();
            });
        });
    });
    describe('Batch Delete Route', () => {
        it('should batch delete a location', done => {
            let versionId;
            let location;

            async.series([
                done => s3.putObject({
                    Bucket: TEST_BUCKET,
                    Key: 'batch-delete-test-key',
                    Body: new Buffer('hello'),
                }, done),
                done => s3.getObject({
                    Bucket: TEST_BUCKET,
                    Key: 'batch-delete-test-key',
                }, (err, data) => {
                    assert.ifError(err);
                    assert.strictEqual(data.Body.toString(), 'hello');
                    versionId = data.VersionId;
                    done();
                }),
                done => {
                    makeBackbeatRequest({
                        method: 'GET', bucket: TEST_BUCKET,
                        objectKey: 'batch-delete-test-key',
                        resourceType: 'metadata',
                        authCredentials: backbeatAuthCredentials,
                        queryObj: {
                            versionId,
                        },
                    }, (err, data) => {
                        assert.ifError(err);
                        assert.strictEqual(data.statusCode, 200);
                        const metadata = JSON.parse(
                            JSON.parse(data.body).Body);
                        location = metadata.location;
                        done();
                    });
                },
                done => {
                    const options = {
                        authCredentials: backbeatAuthCredentials,
                        hostname: ipAddress,
                        port: 8000,
                        method: 'POST',
                        path: '/_/backbeat/batchdelete',
                        requestBody:
                        `{"Locations":${JSON.stringify(location)}}`,
                        jsonResponse: true,
                    };
                    makeRequest(options, done);
                },
                done => s3.getObject({
                    Bucket: TEST_BUCKET,
                    Key: 'batch-delete-test-key',
                }, err => {
                    // should error out as location shall no longer exist
                    assert(err);
                    done();
                }),
            ], done);
        });
        it('should fail with error if given malformed JSON', done => {
            async.series([
                done => {
                    const options = {
                        authCredentials: backbeatAuthCredentials,
                        hostname: ipAddress,
                        port: 8000,
                        method: 'POST',
                        path: '/_/backbeat/batchdelete',
                        requestBody: 'NOTJSON',
                        jsonResponse: true,
                    };
                    makeRequest(options, done);
                },
            ], err => {
                assert(err);
                done();
            });
        });
        it('should skip batch delete of a non-existent location', done => {
            async.series([
                done => {
                    const options = {
                        authCredentials: backbeatAuthCredentials,
                        hostname: ipAddress,
                        port: 8000,
                        method: 'POST',
                        path: '/_/backbeat/batchdelete',
                        requestBody:
                        '{"Locations":' +
                            '[{"key":"abcdef","dataStoreName":"us-east-1"}]}',
                        jsonResponse: true,
                    };
                    makeRequest(options, done);
                },
            ], done);
        });
    });
});
