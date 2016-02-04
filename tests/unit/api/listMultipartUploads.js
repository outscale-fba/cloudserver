import assert from 'assert';
import async from 'async';
import { parseString } from 'xml2js';

import bucketPut from '../../../lib/api/bucketPut';
import constants from '../../../constants';
import initiateMultipartUpload from '../../../lib/api/initiateMultipartUpload';
import listMultipartUploads from '../../../lib/api/listMultipartUploads';
import metadata from '../metadataswitch';
import { DummyRequestLogger, makeAuthInfo } from '../helpers';

const log = new DummyRequestLogger();

const canonicalID = 'accessKey1';
const authInfo = makeAuthInfo(canonicalID);
const namespace = 'default';
const bucketName = 'bucketname';
const mpuBucket = `${constants.mpuBucketPrefix}${bucketName}`;

describe('listMultipartUploads API', () => {
    beforeEach((done) => {
        metadata.deleteBucket(bucketName, log, () => {
            metadata.deleteBucket(mpuBucket, log, () => done());
        });
    });

    after((done) => {
        metadata.deleteBucket(bucketName, log, () => {
            metadata.deleteBucket(mpuBucket, log, () => done());
        });
    });

    const prefix = 'sub';
    const delimiter = '/';
    const objectName1 = `${prefix}${delimiter}objectName1`;
    const objectName2 = `${prefix}${delimiter}objectName2`;
    const objectName3 = 'notURIvalid$$';

    const testPutBucketRequest = {
        bucketName,
        namespace,
        lowerCaseHeaders: {},
        url: `/${bucketName}`,
    };
    const testInitiateMPURequest1 = {
        bucketName,
        namespace,
        objectKey: objectName1,
        lowerCaseHeaders: {},
        url: `/${bucketName}/${objectName1}?uploads`,
    };
    const testInitiateMPURequest2 = {
        bucketName,
        namespace,
        objectKey: objectName2,
        lowerCaseHeaders: {},
        url: `/${bucketName}/${objectName2}?uploads`,
    };
    const testInitiateMPURequest3 = {
        bucketName,
        namespace,
        objectKey: objectName3,
        lowerCaseHeaders: {},
        url: `/${bucketName}/${objectName3}?uploads`,
    };

    it('should return the name of the common prefix ' +
       'of common prefix object keys for multipart uploads if delimiter ' +
       'and prefix specified', (done) => {
        const commonPrefix = `${prefix}${delimiter}`;
        const testListRequest = {
            bucketName,
            namespace,
            lowerCaseHeaders: {
                host: '/'
            },
            url: `/${bucketName}?uploads&delimiter=/&prefix=sub`,
            query: {
                delimiter: delimiter,
                prefix: prefix
            }
        };

        async.waterfall([
            function waterfall1(next) {
                bucketPut(authInfo,  testPutBucketRequest, log,
                    next);
            },
            function waterfall2(success, next) {
                assert.strictEqual(success, 'Bucket created');
                initiateMultipartUpload(authInfo,
                    testInitiateMPURequest1, log, next);
            },
            function waterfall3(result, next) {
                initiateMultipartUpload(authInfo,
                    testInitiateMPURequest2, log, next);
            },
            function waterfall4(result, next) {
                listMultipartUploads(authInfo,
                    testListRequest, log, next);
            },
            function waterfall4(result, next) {
                parseString(result, next);
            }
        ],
        function waterfallFinal(err, result) {
            assert.strictEqual(result.ListMultipartUploadsResult
                .CommonPrefixes[0].Prefix[0],
                commonPrefix);
            done();
        });
    });

    it('should return list of all multipart uploads if ' +
       'no delimiter specified', (done) => {
        const testListRequest = {
            bucketName,
            namespace,
            lowerCaseHeaders: {
                host: '/'
            },
            url: `/${bucketName}?uploads`,
            query: {}
        };


        async.waterfall([
            function waterfall1(next) {
                bucketPut(authInfo,  testPutBucketRequest, log,
                    next);
            },
            function waterfall2(success, next) {
                assert.strictEqual(success, 'Bucket created');
                initiateMultipartUpload(authInfo,
                    testInitiateMPURequest1, log, next);
            },
            function waterfall3(result, next) {
                initiateMultipartUpload(authInfo,
                    testInitiateMPURequest2, log, next);
            },
            function waterfall4(result, next) {
                listMultipartUploads(authInfo,
                    testListRequest, log, next);
            },
            function waterfall5(result, next) {
                parseString(result, next);
            }
        ],
        function waterfallFinal(err, result) {
            assert.strictEqual(result.ListMultipartUploadsResult
                .Upload[0].Key[0], objectName1);
            assert.strictEqual(result.ListMultipartUploadsResult
                .Upload[1].Key[0], objectName2);
            assert.strictEqual(result.ListMultipartUploadsResult
                .IsTruncated[0], 'false');
            done();
        });
    });

    it('should return no more keys than ' +
       'max-uploads specified', (done) => {
        const testListRequest = {
            bucketName,
            namespace,
            lowerCaseHeaders: {
                host: '/'
            },
            url: `/${bucketName}?uploads`,
            query: {
                'max-uploads': '1',
            }
        };

        async.waterfall([
            function waterfall1(next) {
                bucketPut(authInfo,  testPutBucketRequest, log,
                    next);
            },
            function waterfall2(success, next) {
                assert.strictEqual(success, 'Bucket created');
                initiateMultipartUpload(authInfo,
                    testInitiateMPURequest1, log, next);
            },
            function waterfall3(result, next) {
                initiateMultipartUpload(authInfo,
                    testInitiateMPURequest2, log, next);
            },
            function waterfall4(result, next) {
                listMultipartUploads(authInfo,
                    testListRequest, log, next);
            },
            function waterfall5(result, next) {
                parseString(result, next);
            }
        ],
        function waterfallFinal(err, result) {
            assert.strictEqual(result.ListMultipartUploadsResult
                .Upload[0].Key[0], objectName1);
            assert.strictEqual(result.ListMultipartUploadsResult
                .Upload[1], undefined);
            assert.strictEqual(result.ListMultipartUploadsResult
                .IsTruncated[0], 'true');
            assert.strictEqual(result.ListMultipartUploadsResult
                .NextKeyMarker[0], objectName2);
            assert(result.ListMultipartUploadsResult
                .NextUploadIdMarker[0].length > 5);
            done();
        });
    });

    it('should url encode object key name ' +
       'if requested', (done) => {
        const testListRequest = {
            bucketName,
            namespace,
            lowerCaseHeaders: {
                host: '/'
            },
            url: `/${bucketName}?uploads`,
            query: {
                'encoding-type': 'url',
            }
        };

        async.waterfall([
            function waterfall1(next) {
                bucketPut(authInfo,  testPutBucketRequest, log,
                    next);
            },
            function waterfall2(success, next) {
                assert.strictEqual(success, 'Bucket created');
                initiateMultipartUpload(authInfo,
                    testInitiateMPURequest1, log, next);
            },
            function waterfall3(result, next) {
                initiateMultipartUpload(authInfo,
                    testInitiateMPURequest2, log, next);
            },
            function waterfall4(result, next) {
                initiateMultipartUpload(authInfo,
                    testInitiateMPURequest3, log, next);
            },
            function waterfall5(result, next) {
                listMultipartUploads(authInfo,
                    testListRequest, log, next);
            },
            function waterfall6(result, next) {
                parseString(result, next);
            }
        ],
        function waterfallFinal(err, result) {
            assert.strictEqual(result.ListMultipartUploadsResult
                .Upload[0].Key[0], encodeURIComponent(objectName3));
            assert.strictEqual(result.ListMultipartUploadsResult
                .Upload[1].Key[0], encodeURIComponent(objectName1));
            done();
        });
    });

    it('should return key following specified ' +
    'key-marker', (done) => {
        const testListRequest = {
            bucketName,
            namespace,
            lowerCaseHeaders: {
                host: '/'
            },
            url: `/${bucketName}?uploads`,
            query: {
                'key-marker': objectName1,
            }
        };

        async.waterfall([
            function waterfall1(next) {
                bucketPut(authInfo,  testPutBucketRequest, log,
                    next);
            },
            function waterfall2(success, next) {
                assert.strictEqual(success, 'Bucket created');
                initiateMultipartUpload(authInfo,
                    testInitiateMPURequest1, log, next);
            },
            function waterfall3(result, next) {
                initiateMultipartUpload(authInfo,
                    testInitiateMPURequest2, log, next);
            },
            function waterfall4(result, next) {
                initiateMultipartUpload(authInfo,
                    testInitiateMPURequest3, log, next);
            },
            function waterfall5(result, next) {
                listMultipartUploads(authInfo,
                    testListRequest, log, next);
            },
            function waterfall6(result, next) {
                parseString(result, next);
            }
        ],
        function waterfallFinal(err, result) {
            assert.strictEqual(result.ListMultipartUploadsResult
                .Upload[0].Key[0], objectName2);
            assert.strictEqual(result.ListMultipartUploadsResult
                .Upload[1], undefined);
            done();
        });
    });
});
